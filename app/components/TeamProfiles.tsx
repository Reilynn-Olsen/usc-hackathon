// Fill these in when the team is ready to publish its profiles.
export const TEAM_MEMBERS = [
  {
    id: "member-1",
    name: "Kenny Luu",
    linkedInUrl: "https://www.linkedin.com/in/kenny-luu-kl/",
  },
  {
    id: "member-2",
    name: "Reilynn Olsen",
    linkedInUrl: "https://www.linkedin.com/in/reilynn-olsen/",
  },
];

export default function TeamProfiles({
  compact = false,
}: {
  compact?: boolean;
}) {
  return (
    <ul className={`team-profiles${compact ? " team-profiles--compact" : ""}`}>
      {TEAM_MEMBERS.map((member, index) => {
        const name =
          member.name || `Team member ${String(index + 1).padStart(2, "0")}`;
        const profile = (
          <>
            <span className="linkedin-mark" aria-hidden="true">
              in
            </span>
            <span className="team-profile__details">
              <strong>{name}</strong>
              {!compact && (
                <span>
                  {member.linkedInUrl
                    ? "Contact on LinkedIn"
                    : "LinkedIn coming soon"}
                </span>
              )}
            </span>
          </>
        );

        return (
          <li key={member.id}>
            {member.linkedInUrl ? (
              <a
                className="team-profile"
                href={member.linkedInUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${name} on LinkedIn (opens in a new tab)`}
              >
                {profile}
              </a>
            ) : (
              <span className="team-profile team-profile--pending">
                {profile}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
