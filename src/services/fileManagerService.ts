import { invokeCommand } from "../lib/desktopBridge";

type RevealInFileManagerRequest = {
  path: string;
  reveal: boolean;
};

export const revealInFileManager = ({
  path,
  reveal,
}: RevealInFileManagerRequest) =>
  invokeCommand("reveal_in_file_manager", { path, reveal });
