import { useCallback, useEffect, useRef, useState } from "react";

type Overlay = { title: string; subtitle: string } | null;
export function useMutationController(setBlockingOverlay: (overlay: Overlay) => void) {
  const [isMutating, setIsMutating] = useState(false);
  const [mutationSpinnerLabel, setMutationSpinnerLabel] = useState<string | null>(null);
  const mutationSpinnerTimeoutRef = useRef<number | null>(null);
  const isMutatingRef = useRef(false);
  const runMutationWithSpinner = useCallback(
    async (spinnerLabel: string, operation: () => Promise<void>) => {
      if (isMutatingRef.current) {
        return;
      }
      isMutatingRef.current = true;
      setIsMutating(true);
      setBlockingOverlay({
        title: spinnerLabel.replace(/…$/, ""),
        subtitle: "This operation is in progress. Please wait...",
      });
      if (mutationSpinnerTimeoutRef.current) {
        window.clearTimeout(mutationSpinnerTimeoutRef.current);
      }
      mutationSpinnerTimeoutRef.current = window.setTimeout(() => {
        setMutationSpinnerLabel(spinnerLabel);
      }, 250);
      try {
        await operation();
      } finally {
        isMutatingRef.current = false;
        setIsMutating(false);
        if (mutationSpinnerTimeoutRef.current) {
          window.clearTimeout(mutationSpinnerTimeoutRef.current);
          mutationSpinnerTimeoutRef.current = null;
        }
        setMutationSpinnerLabel(null);
        setBlockingOverlay(null);
      }
    },
    [setBlockingOverlay],
  );


  useEffect(() => () => { if (mutationSpinnerTimeoutRef.current !== null) window.clearTimeout(mutationSpinnerTimeoutRef.current); }, []);
  return { isMutating, mutationSpinnerLabel, runMutationWithSpinner };
}
