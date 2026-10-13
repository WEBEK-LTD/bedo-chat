/** Length in characters (Unicode code points), as the database counts it, not UTF-16 units. */
export const characterCount = (text: string): number => Array.from(text).length;
