"use client";

const PALETTES: ReadonlyArray<[string, string]> = [
  ["#176b5b", "#338d75"],
  ["#3f5a80", "#57708d"],
  ["#4d6a4a", "#76875a"],
  ["#6a4b56", "#8a6a55"],
];

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 997;
  return h;
}

export function WebAvatar({
  name = "User",
  image,
  size = 20,
}: {
  name?: string;
  image?: string | null;
  size?: number;
}) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "?";
  const [from, to] = PALETTES[hashName(name) % PALETTES.length];

  return (
    <span
      className="tina-web-avatar"
      style={{
        width: size,
        height: size,
        background: image ? undefined : `linear-gradient(135deg, ${from}, ${to})`,
        fontSize: Math.max(9, Math.round(size * 0.42)),
      }}
      aria-hidden="true"
    >
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={image} alt="" referrerPolicy="no-referrer" />
      ) : (
        initials
      )}
    </span>
  );
}
