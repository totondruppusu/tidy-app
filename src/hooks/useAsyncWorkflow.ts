import { useCallback, useMemo, useState } from "react";

export type AsyncWorkflowPhase = "idle" | "loading" | "success" | "error";
export type AsyncWorkflowStatus = "idle" | "loading" | "error";

export const getAsyncErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const useAsyncWorkflow = (
  initialPhase: AsyncWorkflowPhase = "idle",
) => {
  const [phase, setPhase] = useState<AsyncWorkflowPhase>(initialPhase);
  const [error, setError] = useState<string | null>(null);

  const status = useMemo<AsyncWorkflowStatus>(
    () => (phase === "success" ? "idle" : phase),
    [phase],
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
  }, []);

  const start = useCallback(() => {
    setPhase("loading");
    setError(null);
  }, []);

  const succeed = useCallback(() => {
    setPhase("success");
    setError(null);
  }, []);

  const fail = useCallback((nextError: string) => {
    setPhase("error");
    setError(nextError);
  }, []);

  const run = useCallback(
    async <Result,>(
      operation: () => Promise<Result>,
      callbacks?: {
        onSuccess?: (result: Result) => void;
        onError?: (message: string, cause: unknown) => void;
      },
    ): Promise<Result | null> => {
      start();
      try {
        const result = await operation();
        succeed();
        callbacks?.onSuccess?.(result);
        return result;
      } catch (cause) {
        const message = getAsyncErrorMessage(cause);
        fail(message);
        callbacks?.onError?.(message, cause);
        return null;
      }
    },
    [fail, start, succeed],
  );

  return {
    phase,
    status,
    error,
    isIdle: phase === "idle",
    isLoading: phase === "loading",
    isSuccess: phase === "success",
    isError: phase === "error",
    reset,
    start,
    succeed,
    fail,
    run,
  };
};
