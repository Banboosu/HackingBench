using Hacknet;

namespace HnpfMcpBridge;

public static partial class Executor
{
    private static object BenchHub(OS os, string action, string id)
    {
        if (os.connectedComp == null) throw new ArgumentException("Connect to a mission hub first.");
        if (action != "list" && action != "read" && action != "accept")
            throw new ArgumentException("Use list, read or accept.");
        if (action != "list" && (string.IsNullOrEmpty(id) || id.Length > 128))
            throw new ArgumentException("Invalid mission listing ID.");

        var board = os.connectedComp.daemons.OfType<MissionListingServer>().FirstOrDefault();
        if (board == null)
        {
            // Other hub types have their own native accept methods. Do not
            // treat an article board as one of these contract servers.
            if (action == "read") throw new ArgumentException("Read is currently supported on listing: boards only.");
            return action == "list" ? HubList(os, os.connectedComp.ip) : HubAccept(os, os.connectedComp.ip, id);
        }
        if (os.bootingUp || !os.inputEnabled)
            throw new InvalidOperationException("Game input is not ready; use hn_wait.");
        // The same prerequisites as the board UI: intact server config,
        // public access or a normal terminal login, and a still-present posting.
        if (!board.hasSysfile()) throw new InvalidOperationException("The board is offline (missing config.sys).");
        if (!board.isPublic && !os.connectedComp.userLoggedIn)
            throw new InvalidOperationException("Log in to this board using its supplied account first.");
        var kind = board.missionAssigner ? "contract" : "article";
        if (action == "list")
        {
            var rows = new List<object>();
            for (var i = 0; i < board.missions.Count; i++)
                if (board.hasListingFile(board.missions[i].postingTitle))
                    rows.Add(new Dictionary<string, object> {
                        ["id"] = "listing:" + i, ["title"] = board.missions[i].postingTitle,
                        ["kind"] = kind, ["canAccept"] = CanAcceptListing(os, board),
                    });
            return new Dictionary<string, object> {
                ["ip"] = os.connectedComp.ip, ["hubs"] = new List<object> {
                    new Dictionary<string, object> { ["daemon"] = "MissionListingServer", ["name"] = board.name,
                        ["group"] = board.groupName, ["missions"] = rows },
                },
            };
        }
        int index;
        if (!id.StartsWith("listing:", StringComparison.Ordinal) || !int.TryParse(id.Substring(8), out index)
            || index < 0 || index >= board.missions.Count)
            throw new ArgumentException("Use a numeric listing ID returned by list; refresh after accepting a contract.");
        var mission = board.missions[index];
        if (!board.hasListingFile(mission.postingTitle)) throw new ArgumentException("That posting is no longer on the board.");
        if (action == "read") return new Dictionary<string, object> {
            ["id"] = id, ["title"] = mission.postingTitle, ["body"] = mission.postingBody,
            ["kind"] = kind, ["canAccept"] = CanAcceptListing(os, board),
        };
        if (!board.missionAssigner) throw new InvalidOperationException("This is an article board. Use read, not accept.");
        if (os.currentMission != null) throw new InvalidOperationException("A mission is already active; complete it before accepting another.");
        if (!CanAcceptListing(os, board)) throw new InvalidOperationException("This contract is not available to your current faction.");

        AcceptListing(os, board, index);
        if (!ReferenceEquals(os.currentMission, mission)) throw new InvalidOperationException("The contract was not activated.");
        return new Dictionary<string, object> { ["ok"] = true, ["accepted"] = id, ["title"] = mission.postingTitle };
    }

    private static bool CanAcceptListing(OS os, MissionListingServer board) =>
        board.missionAssigner && os.currentMission == null && os.currentFaction != null
        && string.Equals(os.currentFaction.idName, board.groupName, StringComparison.OrdinalIgnoreCase);

    private static void AcceptListing(OS os, MissionListingServer board, int index)
    {
        // MissionListingServer has NO acceptMission method. Its Accept button
        // is inline in draw(). Mirror that exact sequence (including readMission
        // startup effects), using ONLY the selected, visible board entry.
        // Never accept an arbitrary file path, alter goals/flags, or finish work.
        var mission = board.missions[index];
        os.currentMission = mission;
        ComputerLoader.readMission(mission.reloadGoalsSourceFile);
        mission.sendEmail(os);
        mission.ActivateSuppressedStartFunctionIfPresent();
        board.removeMission(index);
        board.state = 1; // native BOARD state after Accept
    }
}
