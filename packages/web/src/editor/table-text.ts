/** Every text insertion into a table cell must preserve its single line. */
export const singleLine = (text: string): string => text.replace(/[\r\n]+/g, " ");
