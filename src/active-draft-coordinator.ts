interface ActiveDraftRegistration {
  suspend: () => void;
  suspended: boolean;
}

/**
 * Tracks the current cosmetic draft relay for each Telegram session key.
 *
 * Registrations are compared by identity so cleanup from an older relay cannot
 * remove a newer relay that has already claimed the same session key.
 */
export class ActiveDraftCoordinator {
  private readonly registrations = new Map<string, ActiveDraftRegistration>();

  register(key: string, suspend: () => void): () => void {
    const registration: ActiveDraftRegistration = {
      suspend,
      suspended: false,
    };
    this.registrations.set(key, registration);

    return () => {
      if (this.registrations.get(key) === registration) {
        this.registrations.delete(key);
      }
    };
  }

  suspend(key: string): void {
    const registration = this.registrations.get(key);
    if (!registration || registration.suspended) return;
    registration.suspended = true;
    registration.suspend();
  }
}
