import { schoolParticipantGet, schoolParticipantPost } from "@/src/server";

export const runtime = "nodejs";
export function GET(request: Request) { return schoolParticipantGet(request); }
export function POST(request: Request) { return schoolParticipantPost(request); }
