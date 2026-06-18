// ─── ADDITION 1: UPDATED BOARD MATRIX HIGHLIGHT RANGE ───
// When validating playable ranges for A and K cards on the 7-Clubs board layout table, 
// update your checking function to parse 'A' as value 1 and 'K' as value 13.
function getNumericRank(rankStr) {
  if (rankStr === 'A') return 1;
  if (rankStr === 'J') return 11;
  if (rankStr === 'Q') return 12;
  if (rankStr === 'K') return 13;
  return parseInt(rankStr, 10);
}

// Ensure your `checkIfCardPlayable(card, boardMatrix)` checks upper bounds up to 13 and lower down to 1.
// Inside your Seven of Clubs Card play message emitter handler:
// Add a flag `isSpecialRank` to the payload whenever an 'A' or 'K' card is successfully dropped down, 
// so the frontend triggers the modal `alert()` box automatically.

// Example inside socket.on('sevenClubsPlayCard'):
const cardRank = data.rank; // 'A', '2', ..., 'K'
const playerObj = room.players.find(p => p.id === socket.id);

// Play logic execution...
let isSpecial = (cardRank === 'A' || cardRank === 'K');

io.to(room.code).emit('clueActionLogged', {
  text: `${playerObj.name} played an engineering card variant: [Rank ${cardRank} of ${data.suit}]!`,
  isSpecialRank: isSpecial
});

// ─── ADDITION 2: DYNAMIC ELIMINATION STANDINGS (2, 3, 4th Place) ───
// Track placement inside your room data state container structure:
// room.standingsList = []; // Array storing user info objects in order of shedding their hands

// Modify the check hand size step inside the turn loop:
if (playerHand.length === 0) {
  // Verify player isn't already inside the placement list
  if (!room.standingsList.some(s => s.id === activePlayer.id)) {
    room.standingsList.push({
      id: activePlayer.id,
      name: activePlayer.name
    });
    
    io.to(room.code).emit('clueActionLogged', {
      text: `🏆 POSITION DETECTED! ${activePlayer.name} has shed all structural elements and logged a standing placement!`,
      isSpecialRank: false
    });
  }
}

// ─── ADDITION 3: TERMINAL END CONDITION ADAPTATION FOR 2 PLAYERS ───
// Check whether the game has reached its final round condition based on the dynamic player layout count.
// Instead of stopping when 1 player finishes, calculate remaining players who still have elements to discard:

let activePlayersRemaining = room.players.filter(p => {
  const hand = room.playerHands[p.id] || [];
  return hand.length > 0;
});

// Game finishes when only 1 player remains with cards (or 0 players remain)
if (activePlayersRemaining.length <= 1) {
  // If there's one player left stranded, they fill the final spot automatically
  if (activePlayersRemaining.length === 1) {
    const finalPlayer = activePlayersRemaining[0];
    if (!room.standingsList.some(s => s.id === finalPlayer.id)) {
      room.standingsList.push({ id: finalPlayer.id, name: finalPlayer.name });
    }
  }

  room.phase = 'result';
  room.gameOverReason = "All table elements sorted! Final multi-place placement records mapped.";
  io.to(room.code).emit('goToResultScreen', room);
} else {
  // Advance the cycle to the next player with cards remaining in hand
  advanceToNextActiveCardPlayer(room);
}
