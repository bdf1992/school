import { Fragment } from "react";
import type { SchoolGradebook, SchoolGradebookEpisode, SchoolGradebookPhase, SchoolGradeCount, SchoolExperimentReport } from "@/src/core";
import { evidenceLabel, readableStatus } from "./classroom-data";

export function GradeCount({ count }: { count: SchoolGradeCount }) {
	return <span className="block text-xs leading-5" data-testid="grade-count">
		<span className="font-medium text-foreground">{count.correct === null ? "No grade" : `${count.correct} correct`}</span>
		<span className="text-muted-foreground"> · {count.graded} graded / {count.expected} expected</span>
	</span>;
}

function PhaseCounts({ phase }: { phase: SchoolGradebookPhase | undefined }) {
	if (!phase) return <span className="text-xs text-muted-foreground">Not run</span>;
	return <div className="space-y-1">
		<div><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Target</span><GradeCount count={phase.counts.target} /></div>
		<div><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Retention</span><GradeCount count={phase.counts.retention} /></div>
	</div>;
}

export function ExperimentConditions({ report }: { report: SchoolExperimentReport }) {
	const followups = report.conditions.filter((condition) => ["cold", "memory", "transfer"].includes(condition.condition));
	return <div>
		<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{followups.map((condition) => <div key={condition.condition} className="rounded-md border bg-background/50 p-3">
			<p className="text-xs font-medium">{condition.condition === "cold" ? "Cold · no lesson" : condition.condition === "memory" ? "Saved memory" : "Transfer · lesson assisted"}</p>
			<p className="mb-2 mt-1 text-[10px] text-muted-foreground">{condition.condition === "transfer" ? "Fresh parameters in the same task family" : "Fresh context · diagnostic cases"}</p>
			<div><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Target</span><GradeCount count={condition.target} /></div>
			<div className="mt-1"><span className="text-[10px] uppercase tracking-wide text-muted-foreground">Retention</span><GradeCount count={condition.retention} /></div>
			{condition.regressions.length > 0 && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">{condition.regressions.length} regressed case{condition.regressions.length === 1 ? "" : "s"}</p>}
		</div>)}</div>
		<p className="mt-2 text-[10px] text-muted-foreground">Seed {report.seed} · No weight update performed. Persistence and generalization are not established; evidence is limited to this generator and seed.</p>
	</div>;
}

export function ClassroomGradebook({ gradebook, unitId, sessionId, onInspect }: {
	gradebook: SchoolGradebook;
	unitId: string;
	sessionId: string;
	onInspect: (operationId: string) => void;
}) {
	const inScope = (episode: SchoolGradebookEpisode) => episode.class.unitId === unitId && (!sessionId || episode.class.sessionId === sessionId);
	return <div className="overflow-x-auto">
		<table className="w-full text-left text-sm">
			<caption className="sr-only">Owner gradebook for the selected class revision, unit and session. Missing grades are not zero.</caption>
			<thead><tr className="border-b text-xs text-muted-foreground">
				<th scope="col" className="min-w-44 px-4 py-3 font-normal">Learner / episode</th>
				<th scope="col" className="min-w-48 px-4 py-3 font-normal">Baseline</th>
				<th scope="col" className="min-w-48 px-4 py-3 font-normal">Lesson assisted</th>
				<th scope="col" className="min-w-40 px-4 py-3 font-normal">Outcome / evidence</th>
			</tr></thead>
			<tbody>{gradebook.learners.flatMap((learner) => {
				const episodes = learner.episodes.filter(inScope);
				if (!episodes.length) return [<tr key={learner.participantId} className="border-b last:border-0">
					<th scope="row" className="px-4 py-4 align-top font-medium">{learner.participantId}</th>
					<td colSpan={3} className="px-4 py-4 text-sm text-muted-foreground">No episodes in this selection. No grade.</td>
				</tr>];
				return episodes.map((episode) => <Fragment key={episode.operationId}><tr className="border-b last:border-0">
					<th scope="row" className="px-4 py-4 align-top font-normal">
						<div className="font-medium">{learner.participantId}</div>
						<button type="button" className="mt-1 break-all text-left text-xs underline decoration-muted-foreground/50 underline-offset-4 hover:text-foreground" onClick={() => onInspect(episode.operationId)}>{episode.operationId}</button>
						<div className="mt-1 break-all text-xs text-muted-foreground">{episode.learner.model.provider} / {episode.learner.model.id}</div>
						{episode.learner.edition && <div className="text-xs text-muted-foreground">{episode.learner.edition}</div>}
						<div className="mt-1 text-xs capitalize text-muted-foreground">{readableStatus(episode.status)}</div>
					</th>
					<td className="px-4 py-4 align-top"><PhaseCounts phase={episode.baseline} /></td>
					<td className="px-4 py-4 align-top"><PhaseCounts phase={episode.retry} /></td>
					<td className="px-4 py-4 align-top text-xs">
						<p className="capitalize">{episode.comparison ? readableStatus(episode.comparison.outcome) : episode.status === "RUNNING" ? "Comparison pending" : "No complete comparison"}</p>
						<p className="mt-2 text-muted-foreground">{evidenceLabel(episode.evidence)}</p>
						{episode.comparison?.regressedCases.length ? <p className="mt-1 text-amber-600 dark:text-amber-400">{episode.comparison.regressedCases.length} regressed case{episode.comparison.regressedCases.length === 1 ? "" : "s"}</p> : null}
					</td>
				</tr>{episode.experiment && <tr className="border-b last:border-0"><td colSpan={4} className="px-4 pb-4 pt-3"><ExperimentConditions report={episode.experiment} /></td></tr>}</Fragment>);
			})}</tbody>
		</table>
	</div>;
}
