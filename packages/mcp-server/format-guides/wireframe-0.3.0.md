# Writing and editing wireframes

A wireframe is a static UI sketch written as indented lines. A renderer draws it; the source is the document.

```wireframe
page
  text.title Project notes
  text.muted A live wireframe example
  row
    button.primary New note
```

## Lines

Each line is one node: `kind.variant#id key=value Label`. Indent children by exactly two spaces, one level at a time, never with tabs; the first line has no indentation. A line's children are the more-indented lines below it, so moving a line moves its children with it.

- **Roots** stand at the top level: `page` (a screen), `dialog` (its label is the title), `banner.info|warning|danger|success` (a strip), `frame` (captioned block), `phone`. A block may hold several roots; they draw one below the other.
- **Inside a root**, children stack vertically at full width. Only a `row` puts things side by side.
- **Labels** are the rest of the line. `page`, `banner`, `card`, `row`, `toggle` and `table` take no label: give a page its title with `text.title`. Quote a label only if it starts with `word=`.
- **Attributes**: `label="Field name"` on `input` and `select`; `width=256` (pixels) on `page`, `card` and `image`.

## Where each kind goes

| Kind | Goes directly inside | Useful variants |
| --- | --- | --- |
| `text` | root, card, row | `.title` `.strong` `.muted` `.small` `.red` `.amber` `.green` `.blue` |
| `row` | root, card, table (never another row) | `.end` right-aligns, `.between` puts first child left and last right, `.scroll` |
| `card` | top level, root, row | none; holds `text`, `image` and `row` only |
| `button` | row, table cell, frame | `.primary` `.danger` `.link` `.focus` |
| `input`, `select`, `toggle` | root, row | none; a toggle holds `option` (`.current` = chosen) |
| `table` > `row` > `cell` | root | `row.head` header row; `cell.end` right-aligned |
| `chip` | row, cell | `.more` for `+2` |
| `icon` | root, cell, button, option | `.filled`; label is a Tabler icon name such as `settings` |
| `image`, `divider` | image: root, card, row; divider: page, dialog, frame, phone | image `.square` `.round` |

Two consequences matter most. Buttons always need a `row` (or a cell). Fields inside a `card` need a `row` around them.

## Layout recipes

- **Buttons at the bottom right**: a last child `row.end` holding the buttons, secondary first, primary last.
- **Heading with an action at the right**: `row.between` with `text.title` first and the button last.
- **Sidebar beside content**: a `row` holding a narrow `card width=200` (the nav) and a second `card` (the content). Mark the current item `text.strong` and the others `text.muted`.

```wireframe
page
  text.title Settings
  row
    card width=200
      text.strong General
      text.muted Members
      text.muted Billing
    card
      row.between
        text.title General
        button Invite
      row
        input label="Workspace name" Acme Inc.
      row
        select label=Language English
      row
        toggle
          option.current Light
          option Dark
      row.end
        button Cancel
        button.primary Save
```

## Editing

Read the block with `get_doc`, then change it with one `edit_block` call. Make `old_text` the smallest run of whole lines that contains every change, and copy it exactly, including leading spaces.

- **Add an item**: insert a new line with the same indentation as its siblings, at the position it should appear. Order in the source is order on screen.
- **Remove an item**: delete its line and every more-indented line under it.
- **Move an item**: delete its line (and its children) at the old place and insert it under the new parent, re-indented to that parent's depth plus two spaces. Re-indent its children by the same amount.
- **Put two things on one line**: wrap them in a `row` (or change an existing `row` to `row.between` or `row.end`). Do not put a `row` inside a `row`; change the variant of the row you have.
- **Empty container after a move**: if a `row` loses its last child, delete the row too.
- Comments on lines you delete and re-insert do not move with the text.

## Checking your work

The parser reports every problem with its line: an unknown kind, variant or misplaced node is a warning and still draws, as a dashed box or in the wrong place; an indentation or quoting error is an error and draws nothing. Fix every reported line.
