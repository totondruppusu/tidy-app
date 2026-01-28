export const getExtension = (name: string) => {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) {
    return "none";
  }
  return name.slice(lastDot + 1).toLowerCase();
};
