# TripSplitter Mini App: design system

Built for phones inside Telegram, 320 to 430 px wide, used one-handed. Single column, designed at 360 px and checked at 320 and 430.
The guiding rule: keep the common flows visible, and put the less common ones one level down (a menu, a sheet, "More options"). Never hide anything that needs attention.

Code: tokens and components live in `web/src/styles.css`, with by-item styles in `web/src/split-items/items.css`. Shared React pieces are in `web/src/components/` (`ui.tsx`, `icons.tsx`, `ExpenseRow.tsx`, `History.tsx`, `ResetLink.tsx`).

## Tokens

### Type
System font stack only: `-apple-system, "SF Pro Text", "Segoe UI", Roboto, "Helvetica Neue", sans-serif`. No downloads.
Scale: 12 (captions, badges), 13 (secondary, labels), 15 (body), 16 (inputs, never smaller, so iOS does not zoom), 17 (bar titles, sheet titles), 22 (screen titles, balance line), 28 to 34 (amounts that matter).
Weights: 400 body, 500 labels and row titles, 600 to 650 titles and amounts. `font-variant-numeric: tabular-nums` is set on the body, so every figure lines up.

### Space and shape
4 px grid (`--s1` 4 to `--s8` 32). The page gutter is 16 px, or 12 px below 340 px.
Radii: 8 small buttons, 10 controls, 12 fields and banners, 14 cards, 16 sheets, pill for badges and the floating button.
Touch targets are at least 44 px. Small buttons extend their hit area with an invisible `::after`.

### Colour layers
| Role | Light | Dark |
|---|---|---|
| Page | `#F6F9FC` | `#000000` |
| Surface (cards, rows, sheets) | `#FFFFFF` | `#1C1C1E` |
| Raised (inputs, pickers, tiles, segmented track) | `#FFFFFF` inputs with border, `#E9EDF2` track, `#EEF2F6` tiles | `#2C2C2E` |
| Highest (selected segment) | `#FFFFFF` with a soft shadow | `#48484A` |
| Text / secondary / muted | `#0A2540` / `#425466` / `#5B6676` | `#FFFFFF` / `#C7C7CC` / `#A1A1A6` |
| Dividers inside a surface | `#DDE3EA` | `rgba(255,255,255,0.12)` |
| Card edge | `#DDE3EA` hairline plus a very soft shadow | none: the grey surface on black separates it |
| Input border | `#8792A2` (3:1) | none: the field is set apart by its fill |
| Tick and stepper border | `#8792A2` | `#7C7C80` |
| Accent / pressed / tint | `#0B5D4E` / `#094A3E` / `#E3F2EE` | `#2FBF95` / `#27A581` / `rgba(47,191,149,0.18)` |
| Text on accent | `#FFFFFF` | `#000000` |
| Positive text / tint | `#067647` / `#E6F6EF` | `#3DDC97` / `rgba(61,220,151,0.16)` |
| Negative text / tint | `#C4163A` / `#FDECEF` | `#FF5C7A` / `rgba(255,92,122,0.16)` |
| Warning text / tint | `#9A4A06` / `#FEF3E2` | `#FFB020` / `rgba(255,176,32,0.16)` |
| Disabled control | `#5B6676` on `#EEF1F5` | `#6E6E73` on `#2C2C2E` |

The brief's `#0E9F6E` positive and `#B45309` warning fail 4.5:1 for small text on white. They are kept as marks (`--pos-mark`, `--warn-mark`), and darker shades of the same hues are used for text.
The owner suggested about `#C4CCD6` for light input borders, but that measures 1.6:1. `#8792A2` meets the 3:1 rule the owner also set.

### Measured contrast (WCAG ratio, computed)
| Pair | Light | Dark |
|---|---|---|
| Text on surface | 15.54:1 | 17.01:1 |
| Text on page | 14.70:1 | 21.00:1 |
| Secondary on surface | 7.80:1 | 10.10:1 |
| Muted on surface | 5.82:1 | 6.61:1 |
| Muted on page | 5.51:1 | 8.16:1 |
| Muted on raised (inputs, placeholders) | 5.82:1 | 5.42:1 |
| Accent button label | 7.81:1 | 9.01:1 |
| Accent text on surface | 7.81:1 | 7.30:1 |
| Positive on surface | 5.69:1 | 9.63:1 |
| Negative on surface | 5.96:1 | 5.72:1 |
| Warning on surface | 6.26:1 | 9.30:1 |
| Positive / negative / warning badge on its tint | 5.09 / 5.23 / 5.70:1 | 6.85 / 4.61 / 6.65:1 |
| Draft badge on its tint | 6.94:1 | 7.05:1 |
| Input border on surface | 3.15:1 | fields by fill; tick border 4.09:1 |
| Selected segment text | 15.54:1 | 9.12:1 |
| Focus ring against page / control | 7.39 / 7.81:1 | 9.01 / 5.98:1 |

### Motion
120 ms for presses, 200 ms for sheets and disclosures, ease-out (`cubic-bezier(0.2, 0.8, 0.2, 1)`). Everything drops to near zero under `prefers-reduced-motion`.

## Theme
Telegram decides light or dark (`Telegram.WebApp.colorScheme`). `telegram.ts` sets `data-theme` on `<html>`, repaints on `themeChanged`, and sets Telegram's header, background and bottom-bar colours to `--bg`, so the frame matches (`#000000` in dark).
In a plain browser `prefers-color-scheme` decides; `?theme=light|dark` forces one for testing. The app never uses Telegram's own theme colours.

## Components
- **Screen** (`ui.tsx`): a sticky, translucent bar with the way back on the left (Telegram's own back button inside Telegram), a centred title with an optional subtitle, and actions on the right. `largeTitle` puts a big centred title under the bar (Home, No trip).
- **Icon button**: 44 px round, with an accessible name (Edit, Delete, More, Back, All my groups).
- **Buttons**: `btn-primary` (the one accent action on a screen; neutral when disabled, never a paler accent), `btn-secondary`, `btn-ghost` (quiet text action), `btn-danger` (red text), `btn-danger-solid` (a confirm that destroys). Sizes `btn-sm`, `btn-lg`, `btn-block`.
- **Floating action button** (`.fab`): the pill "Add expense", centred above the safe area. A screen that has one adds `.with-fab` bottom padding.
- **Sticky action bar** (`.action-bar`): the primary button of a form, with `env(safe-area-inset-bottom)`. While saving is not possible, the button is disabled and the reason is shown above it (`.save-reason`, `role="alert"`).
- **Card row** (`.card-row`): a rounded card with a 40 px tile, a title (up to two lines), a secondary line, and an end column for amounts. Used for expenses, payments, groups and past trips.
- **List card** (`.list-card` with `.item` rows): one card holding rows separated by hairlines. Used for balances, members, activity, items and history.
- **Tile** (`.tile`): a neutral 40 px square with an icon picked from the title's words, or the emoji the person chose. Groups use the accent-tinted tile with the trip's initial or leading emoji.
- **Avatar** (`<Avatar>`): initials in a tinted circle, drawn from `data-initials` by CSS, so they never become part of a row's text or accessible name.
- **Badge** (`<Badge tone>`): a small tinted pill that always carries words: Draft, Needs rate, Check currency, Ended, Deleted.
- **Banner** (`<Banner kind>`): info, success, warning or error, with an icon and an optional dismiss button. Errors use `role="alert"`.
- **Notice row** (`.notice-row`): a quiet warning-tinted row for what needs attention, such as "2 drafts to finish · Needs rate".
- **Segmented control** (`<Segmented>`): two or three choices. It is a `tablist` for Expenses | Balances and a `radiogroup` for the split type.
- **Pickers** (`.picker`): native selects and the date input dressed as compact buttons. The date input sits transparent over a face that reads "Today", "Yesterday" or "Fri 25 Sep".
- **Amount card** (`.amount-card`): a currency picker, then a large amount input (`inputmode=decimal`, or `numeric` for zero-decimal currencies). For a foreign currency, a tappable **rate row** sits underneath: the rate, its source and the converted amount, with "Change" or "Set". It opens the **exchange rate sheet** (This expense only / All … expenses in this trip), which reuses the Change rate screen's preview-and-apply hook (`api/useTripRateChange.ts`).
- **People card** (`.people-card` with `.person` rows): round ticks for Equally, steppers for Portions, and the same steppers per item for By item. The footer states the default, for example "20.00 SGD per person (5 people)".
- **Disclosure** (`.disclosure`): "More options" with a summary line. It opens by itself for a split by item, a draft, or an expense with its own rate.
- **Bottom sheet** (`<Sheet>`): a grab handle, a dimmed backdrop, and it closes on a tap outside or Escape. Focus moves in and comes back. Confirms, menus, the item editor, the exchange rate, the emoji picker and payment details all use it.
- **Menu** (`<MenuItem>`): icon tile, label, optional hint and chevron. Destructive items are red.
- **History** (`<History>`): a record's own activity, newest first. It shows three entries, then "Show all (n)". Edits list each changed field ("Amount: 30.00 SGD → 45.00 SGD") using the same wording helper as the conflict comparison (`expenseChanges.ts`).
- **States**: `Loading` (spinner plus words), `ErrorState` (with Try again), `Empty` (icon plus a sentence), `.list-empty` (a dashed box inside a section).

## Rules
- One accent action per screen. Colour carries meaning, never decoration.
- Money always carries words or a sign: "You are owed 184.41 SGD", "you lent 20.00 SGD", "owes 3.00 SGD". Because the accent is also green, a positive amount is plain text, never a filled shape.
- Amounts come from the API and are formatted by `format.ts`: thousands separators, the currency code after the amount, no decimals for zero-decimal currencies. The web code does no split, conversion or balance arithmetic. The only sum it makes is a day's total, added up from the converted totals the API returns.
- Defaults read as plain statements: "Dev (you)", "Today", "Equally", "207,500 IDR per person (6 people)".
- An expense that is not the default case opens with its options already expanded.
- Anything that needs attention stays visible: drafts, a missing rate, a currency to check, a refused save.
- People never create drafts. A draft comes from a receipt photo: "Approve and save" confirms it, and "Save changes, approve later" keeps it a draft.
- Every input is at least 16 px. Every target is at least 44 px. The focus ring is a 2 px gap plus 2 px of accent. No screen scrolls sideways at 320 px.
