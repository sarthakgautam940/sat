"use client";

import { useEffect } from "react";
import { startSyncAgent } from "@/lib/sync";

/** Keeps progress in sync across devices once a sync code is set (see lib/sync.ts). */
export function SyncAgent() {
  useEffect(() => startSyncAgent(), []);
  return null;
}
