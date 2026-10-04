// @vitest-environment node
import { expect, it } from "vitest";
import {
  alphaOf, composite, contrast, oklab, pageGrounds, separation, srgb,
} from "./colour.js";

it("composes colour alpha and CSS opacity without eight-bit quantization", () => {
  const painted = composite("rgb(0 0 0 / 50%)", "#fff", 0.5);
  expect(srgb(painted)).toEqual([0.75, 0.75, 0.75]);
  expect(contrast("rgb(0 0 0 / 50%)", "#fff")).toBeCloseTo(3.9766530249, 8);
  expect(alphaOf("OKLCH(60% 0.02 75 / 25%)")).toBe(0.25);
});

it("measures the painted separation of an alpha stroke and declared opaque tokens", () => {
  const ground = "oklch(0.205 0 0)";
  const fill = "oklch(0.275 0.015 75)";
  expect(separation(fill, ground)).toBeCloseTo(Math.hypot(0.07, 0.015), 12);
  expect(separation("oklch(0.275 0.015 75 / 50%)", ground))
    .toBeLessThan(separation(fill, ground));
  expect(oklab("#ffffff").L).toBeCloseTo(1, 6);
});

it("reads every serialized page gradient stop, including legacy RGB commas", () => {
  expect(pageGrounds(
    "radial-gradient(at 50% 0%, rgb(255, 255, 255) 0%, oklch(0.97 0.005 75) 100%)",
    "transparent",
  )).toEqual(["rgb(255, 255, 255)", "oklch(0.97 0.005 75)"]);
  expect(pageGrounds("linear-gradient(#fff, color(srgb 0.9 0.8 0.7))", "transparent"))
    .toEqual(["#fff", "color(srgb 0.9 0.8 0.7)"]);
});

it("fails closed when the backing paint cannot be established", () => {
  expect(() => contrast("var(--ink)", "#fff")).toThrow("unreadable colour");
  expect(() => composite("#000", "rgb(255 255 255 / 50%)"))
    .toThrow("translucent ground");
  expect(() => pageGrounds("url(example.png)", "#fff")).toThrow("painted image");
  expect(() => pageGrounds("linear-gradient(#fff, unreadable 100%)", "#fff"))
    .toThrow("unreadable gradient stop");
  expect(() => pageGrounds("linear-gradient(unreadable, #fff, #000)", "#fff"))
    .toThrow("unreadable gradient stop");
});
