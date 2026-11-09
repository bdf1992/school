import { schoolRunGet, schoolRunPost } from "@/src/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return schoolRunGet(request); }
export function POST(request: Request) { return schoolRunPost(request); }
