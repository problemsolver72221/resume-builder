
export function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();

  return values.filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
