/** Keep binary content separate from the JSON answer and its output schema. */
export class ImageResult {
  constructor(
    readonly payload: object,
    readonly image: { data: string; mimeType: string },
  ) {}
}
