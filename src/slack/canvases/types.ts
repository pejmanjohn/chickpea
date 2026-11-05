export const SLACK_CANVAS_OPERATIONS = [
  'canvases.getContent', 'canvases.sections.lookup',
  'conversations.canvases.create', 'canvases.create', 'canvases.edit',
  'files.info',
] as const;
export type SlackCanvasOperation = typeof SLACK_CANVAS_OPERATIONS[number];
export const CANVAS_ID = /^F[A-Z0-9]{2,}$/;
export type JsonObject = Record<string, unknown>;
export type SlackCanvasesCall = (method: SlackCanvasOperation, input: JsonObject) => Promise<JsonObject>;

export class SlackCanvasError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail?: string,
    readonly canvases?: readonly JsonObject[],
  ) { super(message); this.name = 'SlackCanvasError'; }
}
