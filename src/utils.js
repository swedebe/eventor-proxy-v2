function convertTimeToSeconds(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(":").map(p => parseInt(p));
  if (parts.some(isNaN)) return null;

  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  } else if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return null;
}

function calculatePoints(klassfaktor, position, numberOfStarts) {
  if (!klassfaktor || !position || !numberOfStarts || numberOfStarts === 0) return null;
  const score = klassfaktor * (1 - (position / numberOfStarts));
  return Math.round(score * 100) / 100;
}

function calculateAge(eventDateStr, birthDateStr) {
  try {
    const eventYear = new Date(eventDateStr).getFullYear();
    const birthYear = new Date(birthDateStr).getFullYear();
    return eventYear - birthYear;
  } catch {
    return null;
  }
}

module.exports = {
  convertTimeToSeconds,
  calculatePoints,
  calculateAge
};
