#!/bin/sh
# The two open dictionaries the whole project is derived from.
set -e
cd "$(dirname "$0")"
curl -sL -o dictionary.txt \
  https://raw.githubusercontent.com/skishore/makemeahanzi/master/dictionary.txt
curl -sL -o cedict.txt.gz \
  https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz
gunzip -f cedict.txt.gz
wc -l dictionary.txt cedict.txt
