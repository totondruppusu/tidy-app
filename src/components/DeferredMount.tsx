import { Suspense, useState, type ReactNode } from "react";

// Defer code loading until first use, retaining dialog state on subsequent opens.
export function DeferredMount({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState(active);
  if (active && !opened) setOpened(true);
  return opened || active ? (
    <Suspense fallback={null}>{children}</Suspense>
  ) : null;
}
