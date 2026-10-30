"use client";

import { useEffect, useRef, useState } from "react";
import {
  buildPaymentVerificationCopyText,
  type PaymentVerificationCopyInput,
} from "./payment-verification-copy";

type CopyState = "idle" | "copied" | "error";

export default function PaymentVerificationCopyButton({
  input,
  className = "",
}: {
  input: PaymentVerificationCopyInput;
  className?: string;
}) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(buildPaymentVerificationCopyText(input));
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }

    if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    resetTimerRef.current = setTimeout(() => setCopyState("idle"), 2400);
  }

  return (
    <button
      className={[
        "rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition",
        copyState === "copied"
          ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-200"
          : copyState === "error"
            ? "border-red-500/50 bg-red-500/10 text-red-200"
            : "border-[#3A3A4A] bg-[#121218] text-[#F5F5F7] hover:border-[#FEEF00]/50 hover:text-[#FEEF00]",
        className,
      ].join(" ")}
      type="button"
      onClick={handleCopy}
      title="Copiar los datos compactos para verificar este pago"
    >
      {copyState === "copied" ? "Copiado" : copyState === "error" ? "No se copió" : "Copiar"}
    </button>
  );
}
