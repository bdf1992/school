/** Trusted owner access to immutable classes and derived gradebooks. This does
 * not grant a learner access to a roster or another participant's grades. */
import { MAX_SCHOOL_CLASS_BYTES, SchoolClassError } from "../core/school-class.ts";
import { schoolGradebook } from "../core/school-gradebook.ts";
import { SchoolEpisodeError } from "../core/school-episode.ts";
import type { SchoolClassStore } from "../store/school-classes.ts";
import type { SchoolEpisodeStore } from "../store/school-episodes.ts";
import { CustomBodyLimitError, readBoundedJson } from "./custom-provider-body.ts";
import { desktopAPIAuthorized } from "./desktop-access.ts";
import { schoolClasses, schoolEpisodes } from "./school-state.ts";
import { subscriptionRequestOrigin } from "./web-subscription-http.ts";

export interface SchoolClassOptions { classStore?: SchoolClassStore; episodeStore?: SchoolEpisodeStore }

function authorized(request: Request, mutation: boolean): boolean {
	if (process.env.LH_DESKTOP_SERVER === "1" || process.env.LH_DESKTOP_API_SECRET) return desktopAPIAuthorized(request.headers);
	const supplied = request.headers.get("origin"), origin = subscriptionRequestOrigin(request);
	return Boolean(origin) && request.headers.get("sec-fetch-site") !== "cross-site" && (mutation ? supplied === origin : !supplied || supplied === origin);
}
function response(body: unknown, status = 200): Response { return Response.json(body, { status, headers: { "Cache-Control": "no-store" } }); }
function failure(error: unknown): Response {
	if (error instanceof SchoolClassError || error instanceof SchoolEpisodeError) return response({ error: error.message, code: error.code }, error.status);
	if (error instanceof CustomBodyLimitError) return response({ error: "Class definition exceeds 64 KiB", code: "CLASS_TOO_LARGE" }, 413);
	if (error instanceof SyntaxError) return response({ error: "Invalid JSON body" }, 400);
	return response({ error: "Class storage or gradebook inspection failed; inspect the stored records before retrying" }, 500);
}

export async function schoolClassPost(request: Request, options: SchoolClassOptions = {}): Promise<Response> {
	if (!authorized(request, true)) return response({ error: "Registering a class requires a trusted same-origin request" }, 403);
	if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") return response({ error: "JSON content-type is required" }, 415);
	try {
		const result = (options.classStore ?? schoolClasses).create(await readBoundedJson(request, MAX_SCHOOL_CLASS_BYTES));
		return response(result, result.created ? 201 : 200);
	} catch (error) { return failure(error); }
}

export function schoolClassGet(request: Request, options: SchoolClassOptions = {}): Response {
	if (!authorized(request, false)) return response({ error: "Reading classes and grades requires a trusted request" }, 403);
	try {
		const query = new URL(request.url).searchParams;
		for (const key of query.keys()) if (!["classId", "revision", "gradebook"].includes(key) || query.getAll(key).length !== 1) throw new SchoolClassError("INVALID_CLASS_QUERY", "Specify classId and revision once, with optional gradebook=true");
		const store = options.classStore ?? schoolClasses;
		if (!query.size) return response({ classes: store.list() });
		const id = query.get("classId"), revision = query.get("revision");
		if (!id || !revision || (query.has("gradebook") && query.get("gradebook") !== "true")) throw new SchoolClassError("INVALID_CLASS_QUERY", "Specify classId and revision, with optional gradebook=true");
		const record = store.inspect(id, revision);
		if (!record) return response({ error: "Class revision not found", code: "CLASS_NOT_FOUND" }, 404);
		if (query.has("gradebook")) return response({ gradebook: schoolGradebook(record.definition, (options.episodeStore ?? schoolEpisodes).list()) });
		return response(record);
	} catch (error) { return failure(error); }
}
