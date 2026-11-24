import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '營運管理中心｜OMG! Gelato',
  description: 'OMG! Gelato 營業公告與今日口味管理中心。',
  robots: { index: false, follow: false },
};

export default function ContentAdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
