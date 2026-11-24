import type { Metadata } from 'next';
import FlavorActionsClient from './actions-client';

export const metadata: Metadata = {
  title: '今日口味供應管理｜OMG! Gelato',
  description: '由授權的 LINE 管理員批次恢復供應或下架今日口味。',
  robots: { index: false, follow: false },
};

export default function AdminFlavorActionsPage() {
  return <FlavorActionsClient />;
}
