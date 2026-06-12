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
    {destinationSlots.map((destinationPath, index) => (
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
          {destinationPath ? formatPathLabel(destinationPath) : "Set folder…"}
        </span>
      </button>
    ))}
  </div>
);
