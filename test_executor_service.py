import json
from flask import Flask, request, jsonify
import asyncio
from Agents.TestExecutorAgent.test_execution_agent import AITestAutomationAgent
import os

app = Flask(__name__)

async def run_test(bdd_script):
    try:
        agent = AITestAutomationAgent()
        graph = await agent.create_graph()
        async for event in graph.astream(
                {"messages": [{"role": "user", "content": bdd_script}]},
                stream_mode="values",
                config={"recursion_limit": 100}
        ):
            if event and "messages" in event:
                event["messages"][-1].pretty_print()
    except Exception as e:
        await agent.executor.close()
        raise Exception(f"Test failed {e}")
    

def get_latest_file(directory):
    files = [os.path.join(directory, f) for f in os.listdir(directory) if os.path.isfile(os.path.join(directory, f))]
    if not files:
        return None
    return max(files, key=os.path.getmtime)  # Get the most recently modified file

@app.route("/run-test", methods=["POST"])
def run_test_route():
    data = request.json
    if "script" not in data:
        return jsonify({"error": "Missing 'script' field"}), 400
    try:
        bdd_script = data["script"]
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(run_test(bdd_script))
        return jsonify(json.loads(open(get_latest_file("test_results")).read()))
    except Exception as e:
        return jsonify({"status": "FAIL","message": str(e)})

if __name__ == "__main__":
    app.run(debug=True)
