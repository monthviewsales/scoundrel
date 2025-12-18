SELECT id, txid, side, executed_at, trade_uuid, program
FROM sc_trades
WHERE wallet_id = 1
  AND coin_mint = 'FXzq8HXUMC6QHuSJw4cDwenSmQhXXWXd6Mugmwkgpump'
ORDER BY id DESC
LIMIT 10;