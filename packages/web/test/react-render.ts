import { act, render } from "@testing-library/react";
import type { RenderOptions, RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";

export { act, cleanup, render } from "@testing-library/react";
export type { RenderResult } from "@testing-library/react";

/** Keep async effects (configuration and room setup) inside the initial act. */
export async function renderSettled(
  ui: ReactNode,
  options?: RenderOptions,
): Promise<RenderResult> {
  let view!: RenderResult;
  await act(async () => {
    view = render(ui, options);
  });
  return view;
}
