'use strict';

// JSON の構文エラー文には入力の断片が入るため、ログには分類名だけを出す。
function describeErrorKind(error) {
  return error?.code || error?.name || 'UnknownError';
}

function describeConfigError(error) {
  return error instanceof SyntaxError
    ? '設定ファイルの形式が正しくありません。JSON の書き方を確認してください'
    : error.message;
}

module.exports = { describeErrorKind, describeConfigError };
