export const splitPathSegments = (path: string) => path.split(/[\\/]+/).filter(Boolean);

export const getRelativeSegments = (fullPath: string, basePath: string | null) => {
  const fullSegments = splitPathSegments(fullPath);
  if (!basePath) {
    return fullSegments;
  }
  const baseSegments = splitPathSegments(basePath);
  let index = 0;
  while (index < baseSegments.length && fullSegments[index] === baseSegments[index]) {
    index += 1;
  }
  return fullSegments.slice(index);
};

export const formatRelativeFolder = (fullPath: string, basePath: string | null) => {
  const segments = getRelativeSegments(fullPath, basePath);
  if (segments.length <= 1) {
    return "Root folder";
  }
  return segments.slice(0, -1).join("/");
};

export const extractFolder = (path: string) => {
  const match = path.match(/^(.*)[\\/][^\\/]+$/);
  return match ? match[1] : path;
};
