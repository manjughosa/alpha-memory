# -*- coding: utf-8 -*-
"""Alpha Memory Qdrant vector integration module."""

from qdrant_client import QdrantClient, models
import urllib.request
import json
import os


class VectorIndex:
    """Qdrant 向量索引封装。"""
    
    def __init__(self, root_path, embedding_model="qwen3-embedding:0.6b", 
                 embedding_api="http://127.0.0.1:11434/v1"):
        self.root = root_path
        self.embedding_model = embedding_model
        self.embedding_api = embedding_api
        self.dimensions = 1024
        self.collection = "alpha_memory"
        
        qdrant_path = os.path.join(root_path, "qdrant")
        self.client = QdrantClient(path=qdrant_path)
        
        try:
            self.client.get_collection(self.collection)
        except:
            self.client.create_collection(
                collection_name=self.collection,
                vectors_config=models.VectorParams(
                    size=self.dimensions,
                    distance=models.Distance.COSINE
                )
            )
    
    def embed_texts(self, texts):
        """调用 Ollama embedding API。"""
        payload = json.dumps({"model": self.embedding_model, "input": texts}).encode('utf-8')
        req = urllib.request.Request(
            f"{self.embedding_api}/embeddings",
            data=payload,
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=120.0) as resp:
            result = json.loads(resp.read().decode('utf-8'))
        return [item["embedding"] for item in result["data"]]
    
    def index_node(self, node_id, content, acl_visible=True, sensitivity="private"):
        """索引单个节点。"""
        try:
            vector = self.embed_texts([content])[0]
            # Qdrant 需要整数 id，用 node_id hash 生成
            point_id = abs(hash(node_id)) % (2**63)
            self.client.upsert(
                collection_name=self.collection,
                points=[models.PointStruct(
                    id=point_id,
                    vector=vector,
                    payload={
                        "node_id": node_id,
                        "acl_visible": acl_visible,
                        "sensitivity": sensitivity
                    }
                )]
            )
            return True
        except Exception as e:
            return False
    
    def search(self, query, limit=50, acl_visible=True):
        """向量搜索。"""
        query_vector = self.embed_texts([query])[0]
        results = self.client.query_points(
            collection_name=self.collection,
            query=query_vector,
            limit=limit,
            query_filter=models.Filter(must=[
                models.FieldCondition(
                    key="acl_visible",
                    match=models.MatchValue(value=acl_visible)
                )
            ]),
            with_payload=["node_id"]
        )
        return [(point.payload["node_id"], point.score) for point in results.points]