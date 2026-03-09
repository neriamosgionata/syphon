#!/bin/bash
# Setup OpenSearch Dashboards with log analysis visualizations
# Run this after docker-compose is up and OpenSearch Dashboards is healthy

DASHBOARDS_URL="${DASHBOARDS_URL:-http://localhost:5601}"
OPENSEARCH_URL="${OPENSEARCH_URL:-http://localhost:9200}"

echo "Waiting for OpenSearch Dashboards to be ready..."
until curl -s "$DASHBOARDS_URL/api/status" | grep -q '"state":"green"\|"state":"yellow"'; do
  sleep 5
  echo "  still waiting..."
done
echo "OpenSearch Dashboards is ready!"

# Create index pattern for syphon-logs
echo "Creating syphon-logs index pattern..."
curl -s -X POST "$DASHBOARDS_URL/api/saved_objects/index-pattern/syphon-logs" \
  -H "osd-xsrf: true" \
  -H "Content-Type: application/json" \
  -d '{
    "attributes": {
      "title": "syphon-logs",
      "timeFieldName": "timestamp"
    }
  }' | head -c 200
echo ""

# Create index pattern for syphon-articles
echo "Creating syphon-articles index pattern..."
curl -s -X POST "$DASHBOARDS_URL/api/saved_objects/index-pattern/syphon-articles" \
  -H "osd-xsrf: true" \
  -H "Content-Type: application/json" \
  -d '{
    "attributes": {
      "title": "syphon-articles",
      "timeFieldName": "published_at"
    }
  }' | head -c 200
echo ""

# Set syphon-logs as default index pattern
echo "Setting default index pattern..."
curl -s -X POST "$DASHBOARDS_URL/api/opensearch-dashboards/settings" \
  -H "osd-xsrf: true" \
  -H "Content-Type: application/json" \
  -d '{"changes": {"defaultIndex": "syphon-logs"}}' | head -c 200
echo ""

# Create visualizations via saved objects import
echo "Creating log analysis visualizations..."
curl -s -X POST "$DASHBOARDS_URL/api/saved_objects/_import?overwrite=true" \
  -H "osd-xsrf: true" \
  --form file=@- <<'NDJSON'
{"id":"log-level-pie","type":"visualization","attributes":{"title":"Log Level Distribution","visState":"{\"title\":\"Log Level Distribution\",\"type\":\"pie\",\"aggs\":[{\"id\":\"1\",\"enabled\":true,\"type\":\"count\",\"params\":{},\"schema\":\"metric\"},{\"id\":\"2\",\"enabled\":true,\"type\":\"terms\",\"params\":{\"field\":\"level\",\"orderBy\":\"1\",\"order\":\"desc\",\"size\":10},\"schema\":\"segment\"}],\"params\":{\"type\":\"pie\",\"addTooltip\":true,\"addLegend\":true,\"legendPosition\":\"right\",\"isDonut\":true}}","uiStateJSON":"{}","description":"Distribution of log levels (debug, info, warn, error)","kibanaSavedObjectMeta":{"searchSourceJSON":"{\"index\":\"syphon-logs\",\"query\":{\"query\":\"\",\"language\":\"kuery\"},\"filter\":[]}"}},"references":[{"id":"syphon-logs","name":"kibanaSavedObjectMeta.searchSourceJSON.index","type":"index-pattern"}]}
{"id":"logs-over-time","type":"visualization","attributes":{"title":"Logs Over Time","visState":"{\"title\":\"Logs Over Time\",\"type\":\"histogram\",\"aggs\":[{\"id\":\"1\",\"enabled\":true,\"type\":\"count\",\"params\":{},\"schema\":\"metric\"},{\"id\":\"2\",\"enabled\":true,\"type\":\"date_histogram\",\"params\":{\"field\":\"timestamp\",\"interval\":\"auto\",\"min_doc_count\":1},\"schema\":\"segment\"},{\"id\":\"3\",\"enabled\":true,\"type\":\"terms\",\"params\":{\"field\":\"level\",\"orderBy\":\"1\",\"order\":\"desc\",\"size\":5},\"schema\":\"group\"}],\"params\":{\"type\":\"histogram\",\"addTooltip\":true,\"addLegend\":true,\"legendPosition\":\"right\"}}","uiStateJSON":"{}","description":"Log volume over time by level","kibanaSavedObjectMeta":{"searchSourceJSON":"{\"index\":\"syphon-logs\",\"query\":{\"query\":\"\",\"language\":\"kuery\"},\"filter\":[]}"}},"references":[{"id":"syphon-logs","name":"kibanaSavedObjectMeta.searchSourceJSON.index","type":"index-pattern"}]}
{"id":"errors-over-time","type":"visualization","attributes":{"title":"Errors Over Time","visState":"{\"title\":\"Errors Over Time\",\"type\":\"line\",\"aggs\":[{\"id\":\"1\",\"enabled\":true,\"type\":\"count\",\"params\":{},\"schema\":\"metric\"},{\"id\":\"2\",\"enabled\":true,\"type\":\"date_histogram\",\"params\":{\"field\":\"timestamp\",\"interval\":\"auto\",\"min_doc_count\":0},\"schema\":\"segment\"}],\"params\":{\"type\":\"line\",\"addTooltip\":true,\"addLegend\":true,\"legendPosition\":\"right\"}}","uiStateJSON":"{}","description":"Error and fatal logs over time","kibanaSavedObjectMeta":{"searchSourceJSON":"{\"index\":\"syphon-logs\",\"query\":{\"query\":\"level: error OR level: fatal\",\"language\":\"kuery\"},\"filter\":[]}"}},"references":[{"id":"syphon-logs","name":"kibanaSavedObjectMeta.searchSourceJSON.index","type":"index-pattern"}]}
{"id":"log-context-bar","type":"visualization","attributes":{"title":"Logs by Context","visState":"{\"title\":\"Logs by Context\",\"type\":\"horizontal_bar\",\"aggs\":[{\"id\":\"1\",\"enabled\":true,\"type\":\"count\",\"params\":{},\"schema\":\"metric\"},{\"id\":\"2\",\"enabled\":true,\"type\":\"terms\",\"params\":{\"field\":\"context\",\"orderBy\":\"1\",\"order\":\"desc\",\"size\":15},\"schema\":\"segment\"}],\"params\":{\"type\":\"horizontal_bar\",\"addTooltip\":true,\"addLegend\":false}}","uiStateJSON":"{}","description":"Log count by application context","kibanaSavedObjectMeta":{"searchSourceJSON":"{\"index\":\"syphon-logs\",\"query\":{\"query\":\"\",\"language\":\"kuery\"},\"filter\":[]}"}},"references":[{"id":"syphon-logs","name":"kibanaSavedObjectMeta.searchSourceJSON.index","type":"index-pattern"}]}
{"id":"error-messages","type":"visualization","attributes":{"title":"Top Error Messages","visState":"{\"title\":\"Top Error Messages\",\"type\":\"table\",\"aggs\":[{\"id\":\"1\",\"enabled\":true,\"type\":\"count\",\"params\":{},\"schema\":\"metric\"},{\"id\":\"2\",\"enabled\":true,\"type\":\"terms\",\"params\":{\"field\":\"message.keyword\",\"orderBy\":\"1\",\"order\":\"desc\",\"size\":20},\"schema\":\"bucket\"}],\"params\":{\"perPage\":10,\"showPartialRows\":false,\"showTotal\":false}}","uiStateJSON":"{}","description":"Most frequent error messages","kibanaSavedObjectMeta":{"searchSourceJSON":"{\"index\":\"syphon-logs\",\"query\":{\"query\":\"level: error OR level: warn\",\"language\":\"kuery\"},\"filter\":[]}"}},"references":[{"id":"syphon-logs","name":"kibanaSavedObjectMeta.searchSourceJSON.index","type":"index-pattern"}]}
{"id":"syphon-logs-dashboard","type":"dashboard","attributes":{"title":"Syphon - Application Logs","description":"Real-time application log analysis with level distribution, error tracking, and context breakdown","panelsJSON":"[{\"version\":\"3.5.0\",\"gridData\":{\"x\":0,\"y\":0,\"w\":12,\"h\":12,\"i\":\"1\"},\"panelIndex\":\"1\",\"embeddableConfig\":{},\"panelRefName\":\"panel_1\"},{\"version\":\"3.5.0\",\"gridData\":{\"x\":12,\"y\":0,\"w\":36,\"h\":12,\"i\":\"2\"},\"panelIndex\":\"2\",\"embeddableConfig\":{},\"panelRefName\":\"panel_2\"},{\"version\":\"3.5.0\",\"gridData\":{\"x\":0,\"y\":12,\"w\":24,\"h\":12,\"i\":\"3\"},\"panelIndex\":\"3\",\"embeddableConfig\":{},\"panelRefName\":\"panel_3\"},{\"version\":\"3.5.0\",\"gridData\":{\"x\":24,\"y\":12,\"w\":24,\"h\":12,\"i\":\"4\"},\"panelIndex\":\"4\",\"embeddableConfig\":{},\"panelRefName\":\"panel_4\"},{\"version\":\"3.5.0\",\"gridData\":{\"x\":0,\"y\":24,\"w\":48,\"h\":12,\"i\":\"5\"},\"panelIndex\":\"5\",\"embeddableConfig\":{},\"panelRefName\":\"panel_5\"}]","optionsJSON":"{\"useMargins\":true,\"hidePanelTitles\":false}","timeRestore":true,"timeTo":"now","timeFrom":"now-24h","refreshInterval":{"pause":false,"value":10000},"kibanaSavedObjectMeta":{"searchSourceJSON":"{\"query\":{\"query\":\"\",\"language\":\"kuery\"},\"filter\":[]}"}},"references":[{"id":"log-level-pie","name":"panel_1","type":"visualization"},{"id":"logs-over-time","name":"panel_2","type":"visualization"},{"id":"errors-over-time","name":"panel_3","type":"visualization"},{"id":"log-context-bar","name":"panel_4","type":"visualization"},{"id":"error-messages","name":"panel_5","type":"visualization"}]}

NDJSON
echo ""

echo ""
echo "=== Setup Complete ==="
echo "OpenSearch Dashboards: $DASHBOARDS_URL"
echo "Dashboard: $DASHBOARDS_URL/app/dashboards#/view/syphon-logs-dashboard"
echo ""
