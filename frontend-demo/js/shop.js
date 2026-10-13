// 스킨 상점 (준비 중): 보유 츄르 + 안내만. 상품 목록 · 구매 버튼은 SHOP_OPEN 이 true 가 되기 전까지 만들지 않는다.
import { getOnlineStatus } from './ranking.js';
import { applyUiSkin } from './theme.js';
import { renderWalletBadge, walletView } from './wallet.js';

applyUiSkin();

// 이전 화면(결과 화면 등)에서 왔으면 뒤로가기는 그 화면으로
const back = document.getElementById('shopBack');
back.addEventListener('click', e => {
  if (history.length > 1 && document.referrer && new URL(document.referrer).origin === location.origin) {
    e.preventDefault();
    history.back();
  }
});

getOnlineStatus().then(online => renderWalletBadge(document.getElementById('walletBadge'), walletView(online)));
