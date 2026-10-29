import { getLiffReturnUrl } from '@/lib/linepay';

type PaymentOrder = {
  userId?: string | null;
  orderNo?: string | number;
  pickupNo?: string | number;
  pickupNumber?: string | number;
  pickupCode?: string | number;
  total?: number | string;
  items?: Array<{ name?: string; qty?: number; price?: number; flavorDisplay?: string }>;
};

export async function pushLineMessage(userId: string, message: Record<string, unknown>) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN 未設定');
  const response = await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to: userId, messages: [message] }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || `LINE 推送失敗（HTTP ${response.status}）`);
  }
}

export function buildPaymentSuccessCard(order: PaymentOrder) {
  const orderNo = String(order.orderNo || '—');
  const pickupNo = String(order.pickupNo || order.pickupNumber || order.pickupCode || '待分配');
  const total = Number(order.total || 0);
  const orderUrl = new URL(getLiffReturnUrl());
  orderUrl.searchParams.set('orderNo', orderNo);

  const itemRows: Record<string, unknown>[] = [];
  let itemCount = 0;
  (order.items || []).forEach((item, index) => {
    if (index > 0) itemRows.push({ type: 'separator', margin: 'md', color: '#E5E5E5' });
    const qty = Number(item.qty || 1);
    itemCount += qty;
    itemRows.push({
      type: 'box',
      layout: 'horizontal',
      margin: 'md',
      contents: [
        { type: 'text', text: `${item.name || '冰淇淋'}${qty > 1 ? ` × ${qty}` : ''}`, size: 'md', weight: 'bold', color: '#202938', wrap: false, flex: 5 },
        { type: 'text', text: `$${(Number(item.price || 0) * qty).toFixed(0)}`, size: 'md', weight: 'bold', color: '#202938', align: 'end', gravity: 'center', flex: 2 },
      ],
    });
    if (item.flavorDisplay) itemRows.push({ type: 'text', text: String(item.flavorDisplay).split(/\s*\+\s*/).join('＋'), size: 'sm', color: '#667085', wrap: false, margin: 'xs' });
  });

  return {
    type: 'flex',
    altText: `LINE Pay 付款成功，訂單 ${orderNo} 已成立`,
    contents: {
      type: 'bubble',
      size: 'mega',
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '20px',
        spacing: 'none',
        contents: [
          { type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: '#EAF8EF', cornerRadius: '12px', contents: [
            { type: 'text', text: 'PAYMENT CONFIRMED', size: 'xs', weight: 'bold', color: '#397347', wrap: false },
            { type: 'text', text: '付款成功', size: 'lg', weight: 'bold', color: '#1F6B38', wrap: false, margin: 'sm' },
            { type: 'text', text: 'LINE Pay 已完成付款', size: 'md', weight: 'bold', color: '#2F8A4A', wrap: false, margin: 'sm' },
          ] },
          { type: 'text', text: `線上訂單編號：${orderNo}`, size: 'xs', color: '#667085', wrap: false, margin: 'lg' },
          { type: 'box', layout: 'horizontal', margin: 'lg', alignItems: 'center', contents: [
            { type: 'text', text: '取餐號碼', size: 'sm', weight: 'bold', color: '#667085', wrap: false, flex: 1 },
            { type: 'text', text: pickupNo, size: 'xxl', weight: 'bold', color: '#2F8A4A', align: 'end', wrap: false, flex: 2 },
          ] },
          { type: 'separator', margin: 'lg', color: '#DCE3EC' },
          ...itemRows,
          { type: 'separator', margin: 'lg', color: '#DCE3EC' },
          { type: 'box', layout: 'horizontal', margin: 'lg', alignItems: 'center', contents: [
            { type: 'text', text: `共 ${itemCount} 項`, size: 'sm', color: '#667085', wrap: false, flex: 1 },
            { type: 'text', text: `已付 $${total.toFixed(0)}`, size: 'lg', weight: 'bold', color: '#1F6B38', align: 'end', wrap: false, flex: 1 },
          ] },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', paddingAll: '12px', contents: [
          { type: 'button', style: 'primary', height: 'md', color: '#2F8A4A', action: { type: 'uri', label: '查看已付款訂單', uri: orderUrl.toString() } },
        ],
      },
    },
  };
}
