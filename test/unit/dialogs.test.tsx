import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useConfirmation } from "../../src/hooks/useConfirmation";
import { describeScanProgress } from "../../src/lib/scanProgress";
import { getRelativeSegments } from "../../src/lib/path";

it("confirmation defaults to Cancel, traps focus, ignores repeated requests and restores focus", async () => {
  const answered = vi.fn();
  function Harness() {
    const { confirmDialog, confirmation } = useConfirmation();
    return (
      <>
        <button
          onClick={() =>
            void confirmDialog("Delete this file?", {
              confirmLabel: "Delete",
              danger: true,
            }).then(answered)
          }
        >
          Open
        </button>
        {confirmation}
      </>
    );
  }
  const user = userEvent.setup();
  render(<Harness />);
  const open = screen.getByText("Open");
  await user.click(open);
  expect(screen.getByText("Cancel")).toHaveFocus();
  await user.tab({ shift: true });
  expect(screen.getByText("Delete")).toHaveFocus();
  await user.tab();
  expect(screen.getByText("Cancel")).toHaveFocus();
  fireEvent.click(open);
  expect(answered).not.toHaveBeenCalledWith(true);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(answered).toHaveBeenLastCalledWith(false);
  expect(open).toHaveFocus();
});

describe("scan progress", () => {
  it("does not alternate labels or claim completion during discovery", () => {
    const base = { scanId: "s", scanned: 1024, matched: 15, total: 1024 };
    expect(describeScanProgress({ ...base, phase: "indexing" }, false)).toEqual(
      describeScanProgress({ ...base, phase: "scanning" }, false),
    );
    expect(
      describeScanProgress({ ...base, phase: "duplicates" }, false).title,
    ).toBe("Checking duplicates");
    expect(
      describeScanProgress({ ...base, phase: "finalizing" }, false).title,
    ).toBe("Preparing results");
    expect(
      describeScanProgress({ ...base, phase: "finalizing" }, true).title,
    ).toBe("Stopping scan…");
  });
});

it("handles Windows drive casing, long-path prefixes and UNC shares without phantom folders", () => {
  expect(
    getRelativeSegments(
      String.raw`c:\Users\Sam\Documents\a.txt`,
      String.raw`C:\users\sam\documents`,
    ),
  ).toEqual(["a.txt"]);
  expect(
    getRelativeSegments(
      String.raw`\\?\C:\Users\Sam\Documents\a.txt`,
      String.raw`C:\Users\Sam\Documents`,
    ),
  ).toEqual(["a.txt"]);
  expect(
    getRelativeSegments(
      String.raw`\\?\UNC\SERVER\Share\folder\a.txt`,
      String.raw`\\server\share`,
    ),
  ).toEqual(["folder", "a.txt"]);
  expect(getRelativeSegments("/home/Sam/a.txt", "/home/Sam")).toEqual([
    "a.txt",
  ]);
});
