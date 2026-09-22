import { DESTINATION_SLOT_COUNT } from "../constants/appConstants";
import { formatPathLabel } from "../lib/format";

type DestinationSlotsProps = {
  destinationSlots: (string | null)[];
  disabled: boolean;
  onPickDestination: (slotIndex: number) => void | Promise<unknown>;
};

export const DestinationSlots = ({
  destinationSlots,
  disabled,
  onPickDestination,
}: DestinationSlotsProps) => (
  <div className="destination-row" aria-label="Move destinations">
    {Array.from({ length: DESTINATION_SLOT_COUNT }, (_, index) => {
      const destinationPath = destinationSlots[index] ?? null;
      const pathParts = destinationPath?.split(/[\\/]+/).filter(Boolean) ?? [];
      const parentFolder = pathParts.length > 1 ? pathParts.at(-2) : null;
      const folderName = pathParts.at(-1) ?? null;
      return (
        <button
          key={`destination-${index}`}
          type="button"
          className={`destination-button ${destinationPath ? "is-set" : "is-empty"}`}
          onClick={() => void onPickDestination(index)}
          disabled={disabled}
          title={destinationPath ?? `Set destination ${index + 1}`}
          aria-label={`Set destination ${index + 1}`}
        >
          <span className="destination-index">{index + 1}</span>
          <span className="destination-label">
            {destinationPath ? (
              <>
                {parentFolder && (
                  <span className="destination-parent">{parentFolder} / </span>
                )}
                <span className="destination-folder">
                  {folderName ?? formatPathLabel(destinationPath)}
                </span>
              </>
            ) : (
              "Set folder…"
            )}
          </span>
        </button>
      );
    })}
  </div>
);
