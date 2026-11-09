import { schoolEpisodeGet, schoolEpisodePost } from "@/src/server";

export const runtime = "nodejs";
export function GET(request: Request) { return schoolEpisodeGet(request); }
export function POST(request: Request) { return schoolEpisodePost(request); }
