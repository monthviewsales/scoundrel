-- Show the buy trade that triggered the error (should have the reused uuid)
SELECT id, txid, side, executed_at, wallet_id, coin_mint, trade_uuid, program
FROM sc_trades
WHERE wallet_id = 1
  AND coin_mint = 'FXzq8HXUMC6QHuSJw4cDwenSmQhXXWXd6Mugmwkgpump'
ORDER BY id DESC
LIMIT 5;

-- Show ALL runs in positions for that mint (should currently be just the closed one)
SELECT position_id, trade_uuid, open_at, last_trade_at, closed_at, current_token_amount
FROM sc_positions
WHERE wallet_id = 1
  AND coin_mint = 'FXzq8HXUMC6QHuSJw4cDwenSmQhXXWXd6Mugmwkgpump'
ORDER BY open_at;