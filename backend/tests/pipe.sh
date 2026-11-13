python3 pipeline.py
echo "--- tokens each call used on the fake AI (prompt+answer), by model:"
curl -s localhost:4010/log | python3 -c "import sys,json;[print('  ',x['model'][:28].ljust(28),'prompt',x['prompt'],'answer',x['completion']) for x in json.load(sys.stdin)]"
