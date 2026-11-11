#!/usr/bin/env python3
"""Independent checker for SPACE.prompt.json and its declared continuation form.

The host code implements the six expression forms declared by the seed. It does
not execute arbitrary code, interpret arbitrary natural-language rules, prove
semantic usefulness, or establish that the artifact hosts its own interpreter.
Only Python's standard library is used. Record references never access a network.
"""
from __future__ import annotations

import argparse
import copy
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any


class CheckError(ValueError):
    pass


class UnsupportedForm(CheckError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise CheckError(message)


def unique_object(pairs):
    out = {}
    for key, value in pairs:
        require(key not in out, f'Duplicate JSON object key: {key!r}')
        out[key] = value
    return out


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8'), object_pairs_hook=unique_object,
                      parse_constant=lambda value: (_ for _ in ()).throw(CheckError(f'Invalid JSON number: {value}')))


def canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=True,
                      separators=(',', ':'), allow_nan=False).encode('utf-8')


def payload_digest(artifact: dict) -> str:
    return hashlib.sha256(canonical({'entry': artifact['entry'], 'records': artifact['records']})).hexdigest()


def rehash(artifact: dict) -> dict:
    artifact['integrity'] = {'algorithm': 'sha256', 'digest': payload_digest(artifact)}
    return artifact


def exact_json_numbers(value: Any, path: str = '$') -> None:
    if isinstance(value, float):
        raise CheckError(f'{path}: JSON numbers must be integers; use strings for noninteger rationals')
    if isinstance(value, dict):
        for key, child in value.items():
            exact_json_numbers(child, path + '.' + key)
    elif isinstance(value, list):
        for index, child in enumerate(value):
            exact_json_numbers(child, f'{path}[{index}]')


def normalized_address(value: Any) -> bool:
    if not isinstance(value, str) or not value.startswith('/') or value.endswith('/'):
        return False
    return all(part not in ('', '.', '..') for part in value[1:].split('/'))


def is_ref(value: Any) -> bool:
    return isinstance(value, dict) and set(value) == {'ref'} and isinstance(value['ref'], str)


def resolve(reference: Any, referring: str, records: dict, *, require_target: bool = True) -> str:
    require(is_ref(reference), f'{referring}: reference must be exactly {{"ref": string}}')
    text = reference['ref']
    require(text != '', f'{referring}: empty reference is unresolved')
    require(not re.match(r'^[A-Za-z][A-Za-z0-9+.-]*:', text), f'{referring}: external URI references are unsupported')
    parts = [] if text.startswith('/') else referring[1:].split('/')[:-1]
    for part in text.split('/'):
        if part in ('', '.'):
            continue
        if part == '..':
            require(bool(parts), f'{referring}: reference escapes the envelope root: {text}')
            parts.pop()
        else:
            parts.append(part)
    target = '/' + '/'.join(parts)
    require(normalized_address(target), f'{referring}: reference does not resolve to a record address: {text}')
    if require_target:
        require(target in records, f'{referring}: dangling reference {text!r} -> {target}')
    return target


def iter_refs(value: Any):
    if isinstance(value, dict):
        if 'ref' in value:
            require(is_ref(value), 'An object containing ref must contain exactly one string-valued ref field')
            yield value
        else:
            for child in value.values():
                yield from iter_refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_refs(child)


def validate_graph(records: dict, entry: str) -> dict:
    require(isinstance(records, dict) and bool(records), 'records must be a nonempty map')
    require(normalized_address(entry) and entry in records, 'entry must be an existing normalized absolute address')
    require('/schema/record' in records, 'The supported record schema is missing')
    schema = records['/schema/record']['body']
    require(schema.get('required_fields') == ['type', 'context', 'body'], 'Unsupported record field schema')
    require(schema.get('additional_fields') is False, 'Unsupported record additional-fields contract')
    roles = schema.get('roles')
    require(isinstance(roles, list) and all(isinstance(role, str) for role in roles), 'Schema roles must be strings')
    require(len(set(roles)) == len(roles), 'Duplicate declared role')
    reference_count = 0
    for address, record in records.items():
        require(normalized_address(address), f'Non-normalized stored address: {address!r}')
        require(isinstance(record, dict) and set(record) == {'type', 'context', 'body'}, f'{address}: invalid record shape')
        require(isinstance(record['body'], dict), f'{address}: body must be an object')
        require(record['body'].get('role') in roles, f'{address}: undeclared body role')
        require(resolve(record['type'], address, records) == '/schema/record', f'{address}: unsupported record schema')
        context = resolve(record['context'], address, records)
        require(records[context]['body'].get('role') == 'context', f'{address}: context must reference a context record')
        for reference in iter_refs(record):
            resolve(reference, address, records)
            reference_count += 1
    parents = {}
    for address, record in records.items():
        if record['body']['role'] != 'context':
            continue
        body = record['body']
        require('parent' in body and isinstance(body.get('bindings'), dict), f'{address}: context requires parent and bindings')
        parent = body['parent']
        parents[address] = None if parent is None else resolve(parent, address, records)
        if parents[address] is not None:
            require(records[parents[address]]['body']['role'] == 'context', f'{address}: parent is not a context')
        for binding, reference in body['bindings'].items():
            require(isinstance(binding, str) and binding != '', f'{address}: invalid binding name')
            resolve(reference, address, records)
    # A context's own context reference is intentionally NOT a parent edge.
    for start in parents:
        visited = set()
        current = start
        while current is not None:
            require(current not in visited, f'Context-parent cycle reached from {start}: {current}')
            visited.add(current)
            current = parents[current]
    return {'records': len(records), 'references': reference_count, 'contexts': len(parents), 'parent_graph_acyclic': True}


def lookup(name: str, context: str, records: dict) -> str:
    visited = set()
    while context is not None:
        require(context not in visited, f'Context cycle while looking up {name}')
        visited.add(context)
        require(context in records and records[context]['body']['role'] == 'context', f'Unknown context {context}')
        body = records[context]['body']
        if name in body['bindings']:
            return resolve(body['bindings'][name], context, records)
        context = None if body['parent'] is None else resolve(body['parent'], context, records)
    raise CheckError(f'Unresolved context binding: {name}')


def rational(value: Any) -> Fraction:
    require(not isinstance(value, bool) and isinstance(value, (int, str)), f'Expected exact integer or rational string, got {value!r}')
    try:
        return Fraction(value)
    except (ValueError, ZeroDivisionError) as error:
        raise CheckError(f'Invalid rational scalar {value!r}') from error


def vector(value: Any) -> tuple[Fraction, ...]:
    require(isinstance(value, list) and len(value) == 4, 'A vector requires four coefficients')
    return tuple(rational(component) for component in value)


BASIS = ['1', 'i', 'j', 'k']
UNITS = [tuple(Fraction(int(i == j)) for i in range(4)) for j in range(4)]
SUPPORTED_FORMS = {'basis', 'vector', 'add', 'negate', 'scale', 'multiply'}


def algebra_table(address: str, records: dict):
    require(address in records and records[address]['body']['role'] == 'algebra', f'{address}: expected an algebra record')
    body = records[address]['body']
    require(body.get('basis') == BASIS, f'{address}: checker supports the declared basis order 1,i,j,k')
    table = body.get('multiplication')
    require(isinstance(table, list) and len(table) == 4 and all(isinstance(row, list) and len(row) == 4 for row in table), f'{address}: multiplication table must be 4x4')
    parsed = []
    for row in table:
        converted = []
        for token in row:
            require(isinstance(token, str), f'{address}: invalid table coefficient')
            sign, name = (-1, token[1:]) if token.startswith('-') else (1, token)
            require(name in BASIS, f'{address}: unknown signed basis element {token!r}')
            converted.append(tuple(sign * x for x in UNITS[BASIS.index(name)]))
        parsed.append(converted)
    return parsed


def multiply(left, right, table):
    result = [Fraction(0) for _ in range(4)]
    for i in range(4):
        for j in range(4):
            for k in range(4):
                result[k] += left[i] * right[j] * table[i][j][k]
    return tuple(result)


def algebra_checks(address: str, records: dict) -> dict:
    table = algebra_table(address, records)
    for unit in UNITS:
        require(multiply(UNITS[0], unit, table) == unit, f'{address}: left identity failed')
        require(multiply(unit, UNITS[0], table) == unit, f'{address}: right identity failed')
    for i in range(4):
        for j in range(4):
            for k in range(4):
                left = multiply(multiply(UNITS[i], UNITS[j], table), UNITS[k], table)
                right = multiply(UNITS[i], multiply(UNITS[j], UNITS[k], table), table)
                require(left == right, f'{address}: associativity failed at {BASIS[i]}, {BASIS[j]}, {BASIS[k]}')
    return {'algebra': address, 'identity_cases': 8, 'basis_associativity_cases': 64, 'passed': True}


def evaluate(expression: Any, context: str, records: dict):
    syntax_address = lookup('syntax', context, records)
    syntax = records[syntax_address]['body']
    require(syntax.get('role') == 'grammar', f'{syntax_address}: syntax binding is not a grammar')
    forms = syntax.get('forms')
    if not isinstance(forms, dict) or set(forms) != SUPPORTED_FORMS:
        raise UnsupportedForm(f'Checker does not support grammar {syntax_address}')
    algebra_address = lookup('algebra', context, records)
    table = algebra_table(algebra_address, records)

    def ev(expr, depth=0):
        if depth > 256:
            raise UnsupportedForm('Expression exceeds this checker\'s 256-level evaluation budget')
        require(isinstance(expr, list) and bool(expr) and isinstance(expr[0], str), 'An expression must be a nonempty array starting with a form name')
        op = expr[0]
        if op not in SUPPORTED_FORMS:
            raise UnsupportedForm(f'Unsupported expression form: {op!r}')
        arity = {'basis': 2, 'vector': 2, 'add': 3, 'negate': 2, 'scale': 3, 'multiply': 3}[op]
        require(len(expr) == arity, f'{op}: expected {arity - 1} operands')
        if op == 'basis':
            require(expr[1] in BASIS, f'Unknown basis name: {expr[1]!r}')
            return UNITS[BASIS.index(expr[1])]
        if op == 'vector':
            return vector(expr[1])
        if op == 'negate':
            return tuple(-x for x in ev(expr[1], depth + 1))
        if op == 'scale':
            scalar = rational(expr[1])
            return tuple(scalar * x for x in ev(expr[2], depth + 1))
        left, right = ev(expr[1], depth + 1), ev(expr[2], depth + 1)
        if op == 'add':
            return tuple(a + b for a, b in zip(left, right))
        return multiply(left, right, table)

    return ev(expression), algebra_address


def output_vector(values):
    return [x.numerator if x.denominator == 1 else str(x) for x in values]


def check_artifact(artifact: dict) -> dict:
    require(isinstance(artifact, dict) and set(artifact) == {'entry', 'records', 'integrity'}, 'Unsupported envelope shape')
    exact_json_numbers(artifact)
    integrity = artifact['integrity']
    require(isinstance(integrity, dict) and set(integrity) == {'algorithm', 'digest'}, 'Malformed integrity record')
    require(integrity['algorithm'] == 'sha256' and re.fullmatch(r'[0-9a-f]{64}', integrity['digest'] or '') is not None, 'Unsupported digest declaration')
    digest = payload_digest(artifact)
    require(digest == integrity['digest'], 'Payload digest mismatch')
    records, entry = artifact['records'], artifact['entry']
    graph = validate_graph(records, entry)
    require(records[entry]['body'].get('role') == 'space', 'Entry must describe the space')
    require(resolve(records[entry]['body']['self'], entry, records) == entry, 'Space does not refer to itself')
    require(resolve(records[entry]['body']['enter'], entry, records) == '/protocol/enter', 'Unsupported entry protocol')
    require(records['/dictionary']['body']['entries'] == [] and records['/dictionary']['body']['relations'] == [], 'Seed conceptual dictionary is not empty')
    for address, names in [('/constants', ['a', 'b', 'c']), ('/content', ['x', 'y', 'z'])]:
        require(all(records[address]['body'].get(name, False) is None for name in names), f'{address}: a template handle is assigned')
    dictionary = records['/dictionary']['body']
    require(len(dictionary['families']) == len(set(dictionary['families'])), 'Duplicate dictionary family')
    require(dictionary['capacity_range'] == [0, 8], 'Unsupported declared family capacity range')
    require(type(dictionary['default_capacity']) is int and 0 <= dictionary['default_capacity'] <= 8, 'Invalid default family capacity')
    for family, capacity in dictionary['capacity_overrides'].items():
        require(family in dictionary['families'] and type(capacity) is int and 0 <= capacity <= 8, 'Invalid family capacity override')
    algebra_reports = [algebra_checks(address, records) for address, record in records.items() if record['body']['role'] == 'algebra']
    example_address = '/examples/ij_squared'
    example = records[example_address]['body']
    evaluations = []
    for reference in example['contexts']:
        context = resolve(reference, example_address, records)
        result, algebra = evaluate(example['expression'], context, records)
        evaluations.append({'context': context, 'algebra': algebra, 'result': output_vector(result)})
    expected = {'/contexts/root': [-1, 0, 0, 0], '/contexts/commuting': [1, 0, 0, 0]}
    for evaluation in evaluations:
        require(evaluation['result'] == expected[evaluation['context']], 'Declared ij-squared example contradicts its algebra profile')
    point = records['/examples/point']['body']['placement']
    require(isinstance(point['position'], list) and len(point['position']) == 3, 'Point requires three world coordinates')
    position = [rational(x) for x in point['position']]
    cell = [x.numerator // x.denominator for x in position]
    require(point['cell'] == cell and all(type(x) is int for x in point['cell']), 'Point cell differs from componentwise floor')
    state = vector(point['state'])
    squared_norm = sum(x * x for x in state)
    require(squared_norm == 1, 'Assigned normalized state is not on S3')
    return {'digest_recomputed': digest, 'graph': graph,
            'empty_dictionary': {'families': len(dictionary['families']), 'entries': 0, 'relations': 0, 'unassigned_handles': ['a', 'b', 'c', 'x', 'y', 'z']},
            'algebras': algebra_reports, 'contextual_evaluations': evaluations,
            'point': {'cell_by_floor': cell, 'state_squared_norm': str(squared_norm)}}


def negative_controls(artifact: dict) -> list:
    mutations = [
        ('dangling local reference', lambda a: a['records']['/space']['body'].__setitem__('mathematics', {'ref': '/missing'})),
        ('context-parent cycle', lambda a: a['records']['/contexts/root']['body'].__setitem__('parent', {'ref': './commuting'})),
        ('inconsistent multiplication law', lambda a: a['records']['/algebras/hamilton']['body']['multiplication'][1].__setitem__(1, '1')),
    ]
    results = []
    for name, mutate in mutations:
        altered = copy.deepcopy(artifact)
        mutate(altered)
        rehash(altered)
        require(payload_digest(altered) == altered['integrity']['digest'], 'Negative-control rehash failed')
        try:
            check_artifact(altered)
        except CheckError as error:
            results.append({'control': name, 'digest_valid': True, 'rejected': True, 'reason': str(error)})
        else:
            raise CheckError(f'Negative control was wrongly admitted: {name}')
    return results


def check_response(response: dict, artifact: dict) -> dict:
    require(isinstance(response, dict) and set(response) == {'base_digest', 'entry', 'records'}, 'Continuation must have exactly base_digest, entry, records')
    exact_json_numbers(response)
    require(response['base_digest'] == payload_digest(artifact), 'Continuation is pinned to a different base digest')
    additions = response['records']
    require(isinstance(additions, dict) and bool(additions), 'Continuation records must be nonempty')
    require(not (set(additions) & set(artifact['records'])), 'Continuation overwrites a base record')
    entry = response['entry']
    require(isinstance(entry, str) and entry.startswith('/runs/') and entry in additions, 'Continuation entry must be a fresh /runs/ record')
    records = {**artifact['records'], **additions}
    graph = validate_graph(records, entry)
    run = records[entry]['body']
    require(run['role'] == 'run', 'Continuation entry is not a run')
    require(resolve(run.get('subject'), entry, records) == '/space', 'Run subject must reference /space')
    require(isinstance(run.get('orientation'), str) and run['orientation'].strip(), 'Run lacks an orientation')
    require(isinstance(run.get('checks'), (list, dict)) and bool(run['checks']), 'Run lacks explicit check records')
    for field, role in [('evaluations', 'evaluation'), ('observations', 'observation')]:
        refs = run.get(field)
        require(isinstance(refs, list) and bool(refs), f'Run lacks {field} references')
        for reference in refs:
            target = resolve(reference, entry, records)
            require(records[target]['body']['role'] == role, f'Run {field} reference has the wrong role')
    evaluations, unsupported = [], []
    for address, record in additions.items():
        body = record['body']
        if body['role'] == 'proposal':
            require(body.get('adoption') == 'proposed', f'{address}: a proposal cannot assert adoption')
        if body['role'] != 'evaluation':
            continue
        require(all(key in body for key in ['expression', 'chosen_context', 'algebra', 'result', 'derivation']), f'{address}: incomplete evaluation record')
        require(isinstance(body['derivation'], str) and body['derivation'].strip(), f'{address}: evaluation lacks derivation')
        context = resolve(body['chosen_context'], address, records)
        stated_algebra = resolve(body['algebra'], address, records)
        require(stated_algebra == lookup('algebra', context, records), f'{address}: stated algebra differs from contextual binding')
        claimed = vector(body['result'])
        try:
            result, algebra = evaluate(body['expression'], context, records)
        except UnsupportedForm as error:
            unsupported.append({'address': address, 'reason': str(error)})
            continue
        require(result == claimed, f'{address}: reported result {output_vector(claimed)} differs from recomputed {output_vector(result)}')
        evaluations.append({'address': address, 'context': context, 'algebra': algebra, 'result': output_vector(result), 'recomputed': True})
    seed_expression = artifact['records']['/examples/ij_squared']['body']['expression']
    covered = set()
    novel = 0
    for address, record in additions.items():
        body = record['body']
        if body['role'] != 'evaluation':
            continue
        context = resolve(body['chosen_context'], address, records)
        if body['expression'] == seed_expression:
            covered.add(context)
        else:
            novel += 1
    return {'fresh_records': len(additions), 'graph': graph,
            'evaluations': evaluations, 'unsupported_evaluations': unsupported,
            'all_evaluations_recomputed': not unsupported,
            'default_protocol_coverage': {'both_declared_example_contexts': {'/contexts/root', '/contexts/commuting'} <= covered, 'further_expressions': novel},
            'qualification': 'Numerical results and reference structure checked. Prose truth, reported execution history, semantic usefulness, and completeness of proposed revisions are not certified.'}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifact', nargs='?', type=Path, default=Path(__file__).with_name('SPACE.prompt.json'))
    parser.add_argument('--response', type=Path, help='Validate one JSON continuation against this base')
    parser.add_argument('--output', type=Path, default=Path(__file__).with_name('verification-report.json'))
    args = parser.parse_args()
    report = {'checker': 'SPACE independent exact-rational checker', 'artifact': args.artifact.name,
              'scope': 'Declared finite JSON/reference/context contracts, six expression forms, algebra tables, and the given point example. The checker is host-supplied Python, not a self-hosted interpreter.'}
    try:
        artifact = read_json(args.artifact)
        report['artifact_checks'] = check_artifact(artifact)
        roundtrip = json.loads(json.dumps(artifact, ensure_ascii=False, indent=1), object_pairs_hook=unique_object)
        require(roundtrip == artifact and payload_digest(roundtrip) == artifact['integrity']['digest'], 'JSON serialization round-trip changed content or digest')
        report['serialization_roundtrip'] = {'equal': True, 'digest_unchanged': True}
        report['negative_controls'] = negative_controls(artifact)
        if args.response:
            report['response'] = check_response(read_json(args.response), artifact)
            report['response_file'] = args.response.name
        report['passed'] = not report.get('response', {}).get('unsupported_evaluations')
    except (CheckError, KeyError, TypeError, RecursionError, OSError, json.JSONDecodeError) as error:
        report['passed'] = False
        report['error'] = str(error)
    args.output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if report['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())
