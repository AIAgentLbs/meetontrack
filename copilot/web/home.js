// Home: the day's meetings and their memos. The rows come with the Home task; for now, the heading.
function renderHome(agenda, state) {
  const heading = document.createElement("h2");
  heading.id = "home-heading";
  heading.textContent = t("home.title");
  document.getElementById("home").replaceChildren(heading);
}
