/**
 * Univer factory — a single function that boots the spreadsheet engine for
 * one sheet page.
 *
 * We use the open-source `@univerjs/presets` (Apache-2.0): sheets-core brings
 * the grid, formula engine, number formats and sheet UI; the smaller presets
 * add filters, sort, conditional formatting, data validation, find&replace,
 * notes, hyperlinks and tables. Everything that would need the commercial
 * `@univerjs-pro` packages (charts, print, collaboration) is deliberately NOT
 * loaded here — charts (recharts), print (print layout) and realtime
 * collaboration (our own ops protocol) are built in-app.
 */

import { createUniver, LocaleType } from "@univerjs/presets"
import { UniverSheetsCorePreset } from "@univerjs/presets/preset-sheets-core"
import { UniverSheetsFilterPreset } from "@univerjs/presets/preset-sheets-filter"
import { UniverSheetsSortPreset } from "@univerjs/presets/preset-sheets-sort"
import { UniverSheetsConditionalFormattingPreset } from "@univerjs/presets/preset-sheets-conditional-formatting"
import { UniverSheetsDataValidationPreset } from "@univerjs/presets/preset-sheets-data-validation"
import { UniverSheetsFindReplacePreset } from "@univerjs/presets/preset-sheets-find-replace"
import { UniverSheetsNotePreset } from "@univerjs/presets/preset-sheets-note"
import { UniverSheetsHyperLinkPreset } from "@univerjs/presets/preset-sheets-hyper-link"
import { UniverSheetsTablePreset } from "@univerjs/presets/preset-sheets-table"

import enUS from "@univerjs/presets/preset-sheets-core/locales/en-US"

import "@univerjs/presets/lib/styles/preset-sheets-core.css"
import "@univerjs/presets/lib/styles/preset-sheets-filter.css"
import "@univerjs/presets/lib/styles/preset-sheets-sort.css"
import "@univerjs/presets/lib/styles/preset-sheets-conditional-formatting.css"
import "@univerjs/presets/lib/styles/preset-sheets-data-validation.css"
import "@univerjs/presets/lib/styles/preset-sheets-find-replace.css"
import "@univerjs/presets/lib/styles/preset-sheets-note.css"
import "@univerjs/presets/lib/styles/preset-sheets-hyper-link.css"
import "@univerjs/presets/lib/styles/preset-sheets-table.css"

export interface UniverRuntime {
  univer: ReturnType<typeof createUniver>["univer"]
  univerAPI: ReturnType<typeof createUniver>["univerAPI"]
  dispose: () => void
}

/**
 * Create a Univer instance mounted into `container`.
 *
 * We keep Univer's own formula bar + footer (sheet tabs + zoom status) for
 * the deep grid UI; the VoidSheets chrome (toolbar, command palette, sharing,
 * vault, version history) is layered on top by the sheet page.
 */
export function createUniverRuntime(container: HTMLElement): UniverRuntime {
  const { univer, univerAPI } = createUniver({
    locale: LocaleType.EN_US,
    locales: {
      [LocaleType.EN_US]: enUS,
    },
    presets: [
      UniverSheetsCorePreset({
        container,
        formulaBar: true,
        footer: {
          sheetBar: true,
          statisticBar: true,
          zoomSlider: true,
        },
        statusBarStatistic: true,
      }),
      UniverSheetsFilterPreset(),
      UniverSheetsSortPreset(),
      UniverSheetsConditionalFormattingPreset(),
      UniverSheetsDataValidationPreset(),
      UniverSheetsFindReplacePreset(),
      UniverSheetsNotePreset(),
      UniverSheetsHyperLinkPreset(),
      UniverSheetsTablePreset(),
    ],
  })

  return {
    univer,
    univerAPI,
    dispose: () => univer.dispose(),
  }
}