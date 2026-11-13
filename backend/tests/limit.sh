H='content-type: application/json'; O='origin: http://localhost:3100'
curl -s localhost:4010/seen >/dev/null
START=$(date +%s)
curl -s -X POST localhost:3100/api/study -H "$H" -H "$O" -d '{"action":"ask","notes":"Plants make sugar from light and water in their leaves every single day of the year.","question":"What do plants make?"}' | cut -c1-230; echo
echo "   took $(( $(date +%s) - START ))s; models tried: $(curl -s localhost:4010/seen)"
