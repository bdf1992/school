# Classes

A class is the continuing setting for learning. It connects a roster, curriculum, schedule, peers and assessment policy across episodes. Every newly executed model episode belongs to a named class revision and curriculum unit. Historical version-1 records keep their original meaning.

Classes are available through the [Classroom console](school-classroom.md), CLI and owner API. They provide durable definitions, admission checks, private participant views and a gradebook. The inherited human lesson flow remains separate.

## Run a class

Use Node 26 and a suitable absolute School directory:

```sh
npm run school:class -- register examples/school/byte-parity-class.json --school /tmp/school-demo
npm run school:episode -- examples/school/byte-parity.json --fixture --school /tmp/school-demo --operation parity-a
npm run school:class -- grades generative-structures 1 --school /tmp/school-demo
npm run school:episode -- examples/school/byte-parity.json --fixture --school /tmp/school-demo --operation parity-b --learner local-peer
npm run school:class -- grades generative-structures 1 --school /tmp/school-demo
```

After the first episode, `local-peer` appears with `NO_EPISODES` and no grade. After the second, each learner has a separately attributable result. Both scripted episodes produce target 1/2 → 2/2 and retention 1/1 → 1/1. The fixture demonstrates orchestration and evidence; it does not demonstrate live model learning. Repeating either operation returns its original record without additional participant calls.

`--school` selects a directory containing `classes/` and `episodes/`; it does not select provider credentials or application settings. `--fixture` keeps the enrolled participant IDs and substitutes declared scripted model bindings. For real inference, configure the application connections, edit the episode model references, and omit `--fixture`.

## What the class defines

| Part | Current contract |
| --- | --- |
| Identity | Class ID, explicit revision and title. Repeating an identical definition is idempotent; changed contents require a new revision. |
| Roster | Participant IDs and learner/teacher roles. The class can contain multiple learners and teachers. |
| Curriculum | An embedded versioned snapshot of units, objectives, prerequisite links and world revisions. References must resolve and prerequisites must be acyclic. |
| Schedule | Self-paced study or explicit named session windows with timezone-bearing timestamps. |
| Assessment | `trimmed-exact-v1` with case counts. Different episodes may have different denominators. |
| Peers | Shared class membership with `work: "private"`. Peer work and grades are excluded from participant prompts. |

The class holds references to participants. A participant ID is still a declaration; the continuing participant registry, verified model editions and private durable memory are tracked in [issue #5](https://github.com/bdf1992/school/issues/5). Class membership does not grant provider credentials or override background-use permission. The current API is owner-facing, with the same trust boundary as episode administration.

Curriculum snapshots can be reused across classes. A separate curriculum registry, assignment bank, mastery prerequisites and promotion policy are not yet implemented. A prerequisite link states a curricular dependency; it does not certify any learner's mastery.

## Schedule and session admission

A self-paced class uses:

```json
{ "schedule": { "mode": "self-paced" } }
```

A scheduled class names dated sessions. For example, replacing the dates with the intended study window:

```json
{
  "schedule": {
    "mode": "scheduled",
    "sessions": [{
      "id": "parity-seminar",
      "unitId": "byte-parity",
      "startsAt": "2026-11-09T18:00:00-06:00",
      "endsAt": "2026-11-09T19:00:00-06:00"
    }]
  }
}
```

Timestamps are normalized to UTC. A new episode must start at or after `startsAt` and before `endsAt`; it also names `sessionId` in its class reference. Self-paced work has no dated session reference. An admitted episode keeps its own execution deadlines when the session ends. Admission does not schedule or launch a job automatically.

An episode reference looks like:

```json
{
  "version": 2,
  "class": {
    "classId": "generative-structures",
    "revision": "1",
    "unitId": "byte-parity"
  }
}
```

Before any provider call, School checks the class revision, roster roles, unit, world revision and session window. The resulting record pins the admitted definition, digest, time and public class view. Learners and teachers receive only the selected class/unit/session metadata; the roster and other participants' records remain outside their prompts.

## Grades and peer histories

The gradebook is derived from retained episode evidence. It keeps baseline and lesson-assisted retry separate, including each case's expected coverage, attempted/failed state and grade when available. An ungraded result is `null`; a zero is reserved for evaluated work with no correct cases. Running and failed episodes remain visible, and learners without episodes receive `NO_EPISODES`.

Admission refusals happen before an episode is created. They return an explicit error but do not create an attempt or attendance record. Attendance, missed sessions and an admission audit are later class-management work.

The exact checker compares retained text with an authored key. It does not prove the key is true or establish transfer, long-term retention or weight learning. A regression remains a regression even when another target score improves. There is no automatic class average, letter-grade conversion, peer ranking or graduation rule.

Each class revision has its own gradebook. Old records are not rewritten when the roster or curriculum changes. The owner explicitly selects a revision; there is no active-enrollment revocation workflow yet. Provider permissions continue to be checked live through the existing adapters.

## Inspect and integrate

```sh
npm run school:class -- list --school /tmp/school-demo
npm run school:class -- show generative-structures 1 --school /tmp/school-demo
npm run school:class -- grades generative-structures 1 --school /tmp/school-demo
```

The owner HTTP interface provides:

| Request | Result |
| --- | --- |
| `POST /api/school/classes` with the definition | Register a revision: 201 created or 200 identical replay. |
| `GET /api/school/classes` | Class/revision metadata. |
| `GET /api/school/classes?classId=…&revision=…` | Selected definition and digest. |
| The same GET with `&gradebook=true` | Evidence-derived gradebook for that revision. |

Mutations require JSON and trusted same-origin or desktop authorization. These are owner interfaces, not learner-scoped endpoints. The gradebook excludes raw answers, keys, prompts, lessons and error text, but it still contains classmates' grades and must not be handed to a learner as its task API.

Definitions live at `<school>/classes/<classId>/<revision>/definition.json`; episodes live at `<school>/episodes/<operationId>/record.json`. An incomplete or corrupt record causes an explicit refusal. These are unsigned local files, not a distributed database or a cryptographic attestation of model identity.

The [participant registry](school-participants.md) now supplies continuing state, and [queued execution](school-runs.md) supports explicit due times with an owner-started worker. The continuing class roadmap in [issue #9](https://github.com/bdf1992/school/issues/9) includes recurring timetables, enrollment changes, peer communication and review, group work, attendance and richer assessments. Fleet/cohort scheduling remains in [#6](https://github.com/bdf1992/school/issues/6); broader qualification remains in [#7](https://github.com/bdf1992/school/issues/7).

The [implementation evidence](evidence/school-classes-2026-11-09.json) records the two-learner CLI run, independent parity and grade checks, production HTTP checks, regression coverage and current qualification limits.
