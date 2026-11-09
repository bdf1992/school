"use client";

import { useEffect, useState, type ReactNode } from "react";
import { GraduationCapIcon, RefreshCwIcon } from "lucide-react";
import type { SchoolClassDefinition, SchoolGradebook } from "@/src/core";
import { classChoice, classQuery, classroomError, classroomPost, classroomRequest, EMPTY_REGISTRY, type ClassroomClassSummary, type ClassroomRegistry, type ClassroomRun } from "./classroom-data";
import { ClassroomEvidence } from "./evidence";
import { ClassroomEpisodeForm } from "./episode-form";
import { ClassroomGradebook } from "./gradebook";
import { buttonClass, fieldClass, JsonImportForm } from "./import-form";
import { ClassroomWorkQueue } from "./work-queue";

export function Classroom({ navigation }: { navigation?: ReactNode }) {
	const [classes, setClasses] = useState<ClassroomClassSummary[]>([]);
	const [registry, setRegistry] = useState<ClassroomRegistry>(EMPTY_REGISTRY);
	const [runs, setRuns] = useState<ClassroomRun[]>([]);
	const [selection, setSelection] = useState("");
	const [unitChoice, setUnitChoice] = useState("");
	const [sessionChoice, setSessionChoice] = useState("");
	const [refresh, setRefresh] = useState(0);
	const [loading, setLoading] = useState(true);
	const [indexErrors, setIndexErrors] = useState<string[]>([]);
	const [selected, setSelected] = useState<{ key: string; definition?: SchoolClassDefinition; gradebook?: SchoolGradebook; errors: string[] } | null>(null);
	const [inspectId, setInspectId] = useState("");
	const [registryAction, setRegistryAction] = useState<"register-participant" | "register-connection" | "register-state">("register-participant");
	const reload = () => setRefresh((value) => value + 1);
	useEffect(() => {
		const controller = new AbortController(); let current = true; setLoading(true);
		void Promise.allSettled([
			classroomRequest<{ classes: ClassroomClassSummary[] }>("/api/school/classes", { signal: controller.signal }),
			classroomRequest<ClassroomRegistry>("/api/school/participants", { signal: controller.signal }),
			classroomRequest<{ runs: ClassroomRun[] }>("/api/school/runs", { signal: controller.signal }),
		]).then(([classResult, registryResult, runResult]) => {
			if (!current) return;
			const errors: string[] = [];
			if (classResult.status === "fulfilled") {
				setClasses(classResult.value.classes);
				setSelection((previous) => classResult.value.classes.some((item) => classChoice(item.id, item.revision) === previous) ? previous : classResult.value.classes[0] ? classChoice(classResult.value.classes[0].id, classResult.value.classes[0].revision) : "");
			} else errors.push(`Classes: ${classroomError(classResult.reason)}`);
			if (registryResult.status === "fulfilled") setRegistry(registryResult.value); else errors.push(`Participant registry: ${classroomError(registryResult.reason)}`);
			if (runResult.status === "fulfilled") setRuns(runResult.value.runs); else errors.push(`Work queue: ${classroomError(runResult.reason)}`);
			setIndexErrors(errors); setLoading(false);
		});
		return () => { current = false; controller.abort(); };
	}, [refresh]);
	const classSummary = classes.find((item) => classChoice(item.id, item.revision) === selection);
	const classId = classSummary?.id, revision = classSummary?.revision;
	useEffect(() => {
		if (!classId || !revision) return;
		const key = classChoice(classId, revision), controller = new AbortController(); let current = true;
		const query = classQuery({ id: classId, revision });
		void Promise.allSettled([
			classroomRequest<{ definition: SchoolClassDefinition }>(`/api/school/classes?${query}`, { signal: controller.signal }),
			classroomRequest<{ gradebook: SchoolGradebook }>(`/api/school/classes?${query}&gradebook=true`, { signal: controller.signal }),
		]).then(([definition, gradebook]) => {
			if (!current) return;
			setSelected({ key, ...(definition.status === "fulfilled" ? { definition: definition.value.definition } : {}), ...(gradebook.status === "fulfilled" ? { gradebook: gradebook.value.gradebook } : {}), errors: [definition, gradebook].flatMap((result) => result.status === "rejected" ? [classroomError(result.reason)] : []) });
		});
		return () => { current = false; controller.abort(); };
	}, [classId, revision, refresh]);
	const scope = selected?.key === selection ? selected : null;
	const definition = scope?.definition;
	const unit = definition?.curriculum.units.find((item) => item.id === unitChoice) ?? definition?.curriculum.units[0];
	const sessions = definition?.schedule.mode === "scheduled" ? definition.schedule.sessions.filter((session) => session.unitId === unit?.id) : [];
	const sessionId = sessions.some((session) => session.id === sessionChoice) ? sessionChoice : "";

	return <div className="relative flex h-full min-h-0 flex-col bg-background">
		<header className="lh-drag lh-lights-gutter flex shrink-0 items-center gap-3 border-b px-5 py-3">
			{navigation}<GraduationCapIcon className="size-4 text-muted-foreground" aria-hidden="true" /><h1 className="font-title text-xl">Classroom</h1><span className="rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">Owner</span>
			<button type="button" className={`${buttonClass} lh-no-drag ml-auto`} onClick={reload} disabled={loading}><RefreshCwIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />Refresh</button>
		</header>
		<main className="min-h-0 flex-1 overflow-y-auto">
			<div className="mx-auto max-w-6xl space-y-6 px-5 py-6 sm:px-8">
				<div><h2 className="text-xl font-medium">Teach, run, inspect.</h2><p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">Choose a class revision to see its learners, lessons and recorded results. Model episodes use explicit bindings and keep their evidence with the run.</p></div>
				{indexErrors.length > 0 && <div role="alert" className="space-y-1 rounded-md border border-red-500/30 p-3 text-sm text-red-600 dark:text-red-400">{indexErrors.map((error) => <p key={error}>{error}</p>)}</div>}
				<section className="rounded-lg border bg-card p-4" aria-label="Class selection">
					<div className="grid gap-4 md:grid-cols-3">
						<label className="block text-xs text-muted-foreground">Class revision<select className={`${fieldClass} mt-1 text-foreground`} value={selection} disabled={!classes.length} onChange={(event) => { setSelection(event.target.value); setUnitChoice(""); setSessionChoice(""); setInspectId(""); }}><option value="" disabled>{loading ? "Loading classes…" : "Choose a class"}</option>{classes.map((item) => <option value={classChoice(item.id, item.revision)} key={classChoice(item.id, item.revision)}>{item.title} · {item.revision}</option>)}</select></label>
						<label className="block text-xs text-muted-foreground">Curriculum unit<select className={`${fieldClass} mt-1 text-foreground`} value={unit?.id ?? ""} disabled={!definition} onChange={(event) => { setUnitChoice(event.target.value); setSessionChoice(""); }}><option value="" disabled>Choose a unit</option>{definition?.curriculum.units.map((item) => <option value={item.id} key={item.id}>{item.title}</option>)}</select></label>
						<label className="block text-xs text-muted-foreground">Session<select className={`${fieldClass} mt-1 text-foreground`} value={sessionId} disabled={definition?.schedule.mode !== "scheduled"} onChange={(event) => setSessionChoice(event.target.value)}><option value="">{definition?.schedule.mode === "self-paced" ? "Self-paced" : "All sessions"}</option>{sessions.map((session) => <option value={session.id} key={session.id}>{session.id} · {new Date(session.startsAt).toLocaleString()}</option>)}</select></label>
					</div>
					{!loading && !classes.length && <p className="mt-4 text-sm text-muted-foreground">No class revisions registered yet. Import a class definition to start.</p>}
					<details className="mt-4 border-t pt-3"><summary className="cursor-pointer text-sm">Import a class revision</summary><div className="mt-4"><JsonImportForm label="Class" description="Register an immutable class definition with its roster, curriculum, schedule and private peer policy. Reimporting identical contents keeps the same revision." onImport={async (value) => {
						const result = await classroomPost<{ created: boolean; definition: SchoolClassDefinition; sha256: string }>("/api/school/classes", value);
						const item = { id: result.definition.id, revision: result.definition.revision, title: result.definition.title, sha256: result.sha256 };
						setClasses((previous) => [...previous.filter((entry) => classChoice(entry.id, entry.revision) !== classChoice(item.id, item.revision)), item]); setSelection(classChoice(item.id, item.revision)); setUnitChoice(""); setSessionChoice(""); reload();
						return result.created ? "Class revision registered." : "This class revision is already registered.";
					}} /></div></details>
				</section>
				{classSummary && !scope && <p role="status" className="text-sm text-muted-foreground">Loading class and evidence…</p>}
				{scope?.errors.map((error) => <p role="alert" key={error} className="text-sm text-red-600 dark:text-red-400">{error}</p>)}
				{definition && unit && <>
					<section className="grid gap-5 md:grid-cols-2" aria-label="Class context">
						<div className="rounded-lg border bg-card p-4"><h2 className="font-medium">{unit.title}</h2><p className="mt-1 text-xs text-muted-foreground">{definition.curriculum.title} · {definition.curriculum.revision}</p><ul className="mt-3 list-disc space-y-1 pl-4 text-sm">{unit.objectives.map((objective) => <li key={objective}>{objective}</li>)}</ul>{unit.prerequisites.length > 0 && <p className="mt-3 text-xs text-muted-foreground">Prerequisites: {unit.prerequisites.map((id) => definition.curriculum.units.find((item) => item.id === id)?.title ?? id).join(", ")}</p>}{sessionId && <p className="mt-3 text-xs text-muted-foreground">Session ends {new Date(sessions.find((session) => session.id === sessionId)!.endsAt).toLocaleString()}.</p>}</div>
						<div className="rounded-lg border bg-card p-4"><h2 className="font-medium">Roster</h2><ul className="mt-3 space-y-2">{definition.roster.map((member) => <li key={member.participantId} className="flex items-start justify-between gap-3 text-sm"><span>{registry.participants.find((participant) => participant.id === member.participantId)?.label ?? member.participantId}<span className="ml-2 text-xs text-muted-foreground">{registry.states.filter((state) => state.participantId === member.participantId).length} state revisions</span></span><span className="text-xs capitalize text-muted-foreground">{member.roles.join(", ")}</span></li>)}</ul><p className="mt-4 text-xs text-muted-foreground">Peer work is private. This gradebook is available to the owner.</p></div>
					</section>
					<section className="rounded-lg border bg-card" aria-labelledby="gradebook-heading"><div className="border-b p-4"><h2 id="gradebook-heading" className="font-medium">Evidence-derived grades</h2><p className="mt-1 text-xs leading-5 text-muted-foreground">Correct answers, graded cases and expected cases stay separate. Lesson-assisted gains describe this episode; they do not establish a change to model weights.</p></div>{scope?.gradebook ? <ClassroomGradebook gradebook={scope.gradebook} unitId={unit.id} sessionId={sessionId} onInspect={setInspectId} /> : <p className="p-4 text-sm text-muted-foreground">The gradebook is unavailable. Refresh after resolving the reported error.</p>}</section>
					<details className="rounded-lg border bg-card p-4"><summary className="cursor-pointer font-medium">Prepare a model episode</summary><div className="mt-4"><ClassroomEpisodeForm key={selection} definition={definition} unitId={unit.id} sessionId={sessionId} registry={registry} onQueued={() => reload()} /></div></details>
				</>}
				<ClassroomWorkQueue runs={runs} onRefresh={reload} onInspect={setInspectId} />
				{inspectId && <ClassroomEvidence operationId={inspectId} onClose={() => setInspectId("")} />}
				<details className="rounded-lg border bg-card p-4"><summary className="cursor-pointer text-sm">Participant registry · {registry.participants.length} participants · {registry.states.length} states · {registry.connections.length} connections</summary><div className="mt-4 space-y-4">
					<p className="text-sm text-muted-foreground">Register a participant and connection before importing a state revision. State revisions bind a participant to a model, a connection and saved memory.</p>
					{registry.connections.length > 0 && <ul className="space-y-1 text-sm">{registry.connections.map((connection) => <li key={classChoice(connection.id, connection.revision)}>{connection.label} <span className="text-xs text-muted-foreground">· {connection.revision} · {connection.revoked ? "Revoked" : "Registered"}</span></li>)}</ul>}
					<label className="block max-w-sm text-sm">Import type<select className={`${fieldClass} mt-1`} value={registryAction} onChange={(event) => setRegistryAction(event.target.value as typeof registryAction)}><option value="register-participant">Participant</option><option value="register-connection">Connection</option><option value="register-state">State revision</option></select></label>
					<JsonImportForm key={registryAction} label={registryAction === "register-participant" ? "Participant" : registryAction === "register-connection" ? "Connection" : "State"} description="Import a registry definition. Connection definitions refer to server credentials by name; keep secret values out of JSON files." onImport={async (definition) => { await classroomPost("/api/school/participants", { action: registryAction, definition }); reload(); return "Registry definition registered."; }} />
				</div></details>
			</div>
		</main>
	</div>;
}
