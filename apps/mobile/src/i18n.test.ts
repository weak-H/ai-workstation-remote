import assert from "node:assert/strict";
import test from "node:test";
import { initialLocale, localeDirection, localeOptions, translate } from "./i18n.js";

test("uses a saved language before the browser language", () => {
  const storage = { getItem: () => "en" };
  assert.equal(initialLocale(storage, "zh-CN"), "en");
});

test("defaults to English when no language has been saved", () => {
  const storage = { getItem: () => null };
  assert.equal(initialLocale(storage, "zh-TW"), "en");
  assert.equal(initialLocale(storage, "fr-FR"), "en");
});

test("translates messages and replaces named values", () => {
  assert.equal(translate("zh-CN", "recordCount", { count: 3 }), "3 条记录");
  assert.equal(translate("en", "recordCount", { count: 3 }), "3 records");
  assert.equal(translate("ja", "device"), "デバイス");
  assert.equal(translate("ja", "pullRelease"), "Release to refresh");
});

test("offers the same 21 languages as the README", () => {
  assert.deepEqual(localeOptions.map((option) => option.value), [
    "en", "zh-CN", "zh-TW", "ja", "ko", "tr", "ru", "vi", "th", "de", "es", "fr", "uk", "pl", "pt-BR", "ar", "fa", "id", "it", "el", "ml",
  ]);
});

test("uses right-to-left layout for Arabic and Persian", () => {
  assert.equal(localeDirection("ar"), "rtl");
  assert.equal(localeDirection("fa"), "rtl");
  assert.equal(localeDirection("en"), "ltr");
});
