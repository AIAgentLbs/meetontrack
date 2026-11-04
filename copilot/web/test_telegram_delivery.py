import argparse
import asyncio
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import telegram_delivery


class TelegramDeliveryTests(unittest.TestCase):
    def test_check_never_sends_and_never_opens_login(self):
        client = MagicMock()
        client.connect = AsyncMock()
        client.is_user_authorized = AsyncMock(return_value=True)
        client.disconnect = AsyncMock()
        client.send_file = AsyncMock()
        module = MagicMock()
        module.TelegramClient.return_value = client
        args = argparse.Namespace(config=None, account="synthetic", check=True)
        with patch.dict(sys.modules, telethon=module), patch.object(telegram_delivery, "load_account",
                return_value={"session": "synthetic", "api_id": 1, "api_hash": "synthetic"}):
            result = asyncio.run(telegram_delivery.deliver(args))
        self.assertEqual(result, {"ok": True, "status": "connected"})
        client.send_file.assert_not_called()
        client.disconnect.assert_awaited_once()

    def test_a_failing_disconnect_after_the_send_still_reports_sent(self):
        client = MagicMock()
        client.connect = AsyncMock()
        client.is_user_authorized = AsyncMock(return_value=True)
        client.disconnect = AsyncMock(side_effect=ConnectionError("synthetic"))
        client.send_file = AsyncMock(return_value=MagicMock(id=7))
        module = MagicMock()
        module.TelegramClient.return_value = client
        args = argparse.Namespace(config=None, account="synthetic", check=False, target="me", pdf="r.pdf",
                                  title="t", date="d", note="", drive_folder_url="", drive_html_url="",
                                  drive_pdf_url="")
        with patch.dict(sys.modules, telethon=module), patch.object(telegram_delivery, "load_account",
                return_value={"session": "synthetic", "api_id": 1, "api_hash": "synthetic"}):
            result = asyncio.run(telegram_delivery.deliver(args))
        self.assertEqual(result, {"ok": True, "status": "sent", "message_id": 7})


if __name__ == "__main__":
    unittest.main()
