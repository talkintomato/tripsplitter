# Live receipt tests

Tests in this folder call the real model. They need `OPENAI_API_KEY`, cost money, and are not part of `pnpm test`.

Run them with:

```
OPENAI_API_KEY=... pnpm test:receipts
```

The model is `RECEIPT_MODEL` when that variable is set, otherwise `gpt-6-luna`. `pnpm test:receipts` does not read `.env`, so set the variables in the shell.

## What to add

For each receipt, two files in this folder with the same name:

```
test/receipts/live/
  README.md
  receipts.test.ts
  casa-pepe.jpg
  casa-pepe.expected.json
  ichiran.png
  ichiran.expected.json
```

- The photo: `.jpg`, `.jpeg`, `.png` or `.webp`. Telegram scales photos down to at most 1280 pixels on the long side, so a photo of that size shows what the bot will see.
- The expected result, `<name of the photo without its ending>.expected.json`:

```json
{
  "merchant": "Casa Pepe",
  "total": "84.50",
  "currency": "SGD",
  "items": 12
}
```

| Field | Meaning | How it is compared |
|---|---|---|
| `merchant` | The name as printed, or `null` when the receipt shows none | Ignoring case, spacing and punctuation |
| `total` | The final total as printed, a decimal string without symbol or thousands separator | As a number: `"84.5"` equals `"84.50"` |
| `currency` | The ISO 4217 code, or `null` when the receipt gives no way to tell | Exactly. Use the real code even when the app does not support it, such as `"CHF"` |
| `items` | The number of printed item lines. Discount and voucher lines, subtotal, tax, service charge and total are not items | Exactly |

Aim for 10 receipts, at least two in a foreign currency and one long restaurant bill.

Receipt photos can hold card numbers and names. Check before committing them.

## What the run reports

One test per photo, named after it. A test fails when any of the four fields differs, and names each one that does. At the end a table lists every receipt with `ok` or what was returned against what was expected for each field, followed by the number of matches per field.

- With no photos in the folder the run passes and says so. No key is needed.
- With photos and no `OPENAI_API_KEY`, the run fails with "Set OPENAI_API_KEY to run the live receipt tests." and calls nothing.
- A photo without its `.expected.json` fails that test before the model is called.
