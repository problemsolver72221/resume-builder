'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Props = {
  onLogout?: () => void;
};

const NAV_ITEMS = [
  { href: '/', label: 'Builder' },
  { href: '/test', label: 'Test' },
  { href: '/admin/profiles', label: 'Profiles' },
  { href: '/admin/templates', label: 'Templates' },
  { href: '/admin/prompts', label: 'Prompts' },
  { href: '/admin/groups', label: 'Groups' },
  { href: '/admin/skills', label: 'Skill Library' },
  { href: '/admin/settings', label: 'Settings' },
  { href: '/admin/google-sheets', label: 'Google Sheets' },
];

function isActivePath(pathname: string, href: string): boolean {
  if (href === '/') {
    return pathname === '/';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function AppTopNav({ onLogout }: Props) {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-40 border-b border-gray-200 bg-white/95 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-950/85">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-4 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-6">
          <Link href="/" className="shrink-0 py-4 text-lg font-bold text-gray-900 dark:text-white">
            Tailored Resume Builder
          </Link>
          <nav className="hidden flex-wrap items-center gap-2 md:flex">
            {NAV_ITEMS.map((item) => {
              const isActive = isActivePath(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`rounded-md px-3 py-2 text-sm font-medium transition ${
                    isActive
                      ? 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200'
                      : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white'
                  }`}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          {onLogout ? (
            <button
              type="button"
              onClick={onLogout}
              className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
            >
              Logout
            </button>
          ) : (
            <Link
              href="/admin"
              className="rounded-md px-3 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-slate-300 dark:hover:bg-slate-800 dark:hover:text-white"
            >
              Admin
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
