import { schoolClassGet, schoolClassPost } from "@/src/server";

export const runtime = "nodejs";
export function GET(request: Request) { return schoolClassGet(request); }
export function POST(request: Request) { return schoolClassPost(request); }
