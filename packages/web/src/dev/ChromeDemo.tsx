/**
 * The vendored chrome, next to the chrome it has to live with (#27).
 *
 * Not a screen anybody ships: #74 (workspace switcher, user menu) is the real
 * consumer, and until it lands there is nowhere in the product that opens a
 * Radix popover. This page exists so the claim "a shadcn surface next to an
 * existing one is visually coherent" is something you can look at and a browser
 * test can drive, in both colour schemes, rather than an assertion in a PR.
 *
 * Every trigger is an *existing* product control — `.ub-tool`, `.ub-brand`,
 * the header itself — handed to Radix with `asChild`. That is the whole point:
 * the plain-CSS button and the Tailwind surface it opens have to read as one
 * design, and they only do that if the tokens underneath them are the same
 * ones. Nothing here defines a colour.
 */

import { useState } from "react";
import type { ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/shadcn/dropdown-menu.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/shadcn/popover.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../ui/shadcn/dialog.js";

export function ChromeDemo(): ReactElement {
  const [chosen, setChosen] = useState("uberblick");

  return (
    <main className="ub-app">
      <header className="ub-header">
        <button type="button" className="ub-sidebar-toggle" aria-label="Nothing">
          «
        </button>
        <span className="ub-brand">uberblick</span>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="ub-tool">
              {chosen} ▾
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
            {["uberblick", "ablauf", "scratch"].map((name) => (
              <DropdownMenuItem
                key={name}
                /* The one place the demo asks the bridge for the brand amber
                   by name, so `--color-brand` is exercised rather than merely
                   declared. */
                className={name === chosen ? "text-brand" : undefined}
                onSelect={() => setChosen(name)}
              >
                {name}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled>Add a workspace…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="ub-muted">a header, as the app draws one</span>

        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="ub-tool">
              Popover
            </button>
          </PopoverTrigger>
          <PopoverContent align="start">
            <p className="ub-muted">
              A popover on the product's card surface, its border, its radius and
              the same lift the block menu floats on.
            </p>
          </PopoverContent>
        </Popover>

        <Dialog>
          <DialogTrigger asChild>
            <button type="button" className="ub-tool">
              Dialog
            </button>
          </DialogTrigger>
          <DialogContent closeLabel="Close the demo dialog">
            <DialogTitle>A modal, the same one</DialogTitle>
            <DialogDescription>
              Same scrim and same lift as the settings dialog, which is plain CSS
              — because both read `--scrim` and `--shadow-modal`.
            </DialogDescription>
            <DialogClose asChild>
              {/* The panel is a grid, so a stretched button would span it. */}
              <button type="button" className="ub-tool justify-self-end">
                Done
              </button>
            </DialogClose>
          </DialogContent>
        </Dialog>

        <span className="ub-me" style={{ borderColor: "oklch(0.8 0.18 65)" }}>
          demo
        </span>
      </header>

      <div className="ub-body">
        <nav className="ub-list">
          <div className="ub-list-head">
            <span className="ub-muted">documents</span>
          </div>
          <p className="ub-muted ub-empty">
            The sidebar's own styles, untouched by any of the above.
          </p>
        </nav>
        <section className="ub-pane">
          <div className="ub-column">
            <h1>Chrome demo</h1>
            <p>
              Open each of the three controls in the header, in both colour
              schemes. Geist, the amber accent, the border and radius tokens are
              the product's; the surfaces are Radix.
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
