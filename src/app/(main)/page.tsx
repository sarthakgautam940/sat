import { Suspense } from "react";
import { BankView } from "@/components/BankView";

export default function BankPage() {
  return (
    <Suspense fallback={<div style={{ minHeight: 400 }} />}>
      <BankView />
    </Suspense>
  );
}
